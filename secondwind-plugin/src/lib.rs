use base64::{engine::general_purpose::STANDARD, Engine};
use hdrhistogram::Histogram;
use secondwind_optimize::{tokens::Tiktoken, Optimizer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    ffi::{c_char, c_void, CStr},
    fs,
    path::{Path, PathBuf},
    ptr, slice,
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};

mod text;

// One compressor for the entire proxy. The lock protects Secondwind's mutable API.
struct SharedCompressor {
    optimizer: Optimizer,
    metrics: Metrics,
    rewrite_latency: Histogram<u64>,
    metrics_path: Option<PathBuf>,
    persistence_error: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct Metrics {
    requests: u64,
    rewritten_requests: u64,
    outputs: u64,
    rewritten_outputs: u64,
    tokens_before: u64,
    tokens_after: u64,
    saved_tokens_by_model: BTreeMap<String, u64>,
    #[serde(default)]
    savings_by_method: BTreeMap<String, MethodSavings>,
}

#[derive(Default, Serialize, Deserialize)]
struct MethodSavings {
    saved_tokens: u64,
    rewritten_blocks: u64,
}

#[derive(Serialize, Deserialize)]
struct SavedMetrics {
    metrics: Metrics,
    rewrite_latency: Vec<(u64, u64)>,
}

fn load_metrics(path: &Path) -> Result<(Metrics, Histogram<u64>), String> {
    let mut latency = Histogram::new(3).map_err(|e| e.to_string())?;
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Metrics::default(), latency));
        }
        Err(e) => return Err(e.to_string()),
    };
    let saved: SavedMetrics = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    for (value, count) in saved.rewrite_latency {
        latency.record_n(value, count).map_err(|e| e.to_string())?;
    }
    Ok((saved.metrics, latency))
}

fn save_metrics(path: &Path, metrics: &Metrics, latency: &Histogram<u64>) -> Result<(), String> {
    let buckets: Vec<_> = latency
        .iter_recorded()
        .map(|v| (v.value_iterated_to(), v.count_at_value()))
        .collect();
    let bytes = serde_json::to_vec(&json!({"metrics": metrics, "rewrite_latency": buckets}))
        .map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    fs::rename(temp, path).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct InputPrices {
    checked_on: String,
    sources: Vec<String>,
    usd_per_million_tokens: BTreeMap<String, f64>,
}

fn input_prices() -> &'static InputPrices {
    static PRICES: OnceLock<InputPrices> = OnceLock::new();
    PRICES.get_or_init(|| {
        serde_json::from_str(include_str!("input-prices.json")).expect("public input prices")
    })
}
// Secondwind's Transform trait lacks Send. This instance contains only its built-in
// owned transforms and the thread-safe tokenizer; all access is under this mutex.
unsafe impl Send for SharedCompressor {}
static COMPRESSOR: OnceLock<Mutex<SharedCompressor>> = OnceLock::new();
static STATS_URL: OnceLock<String> = OnceLock::new();

fn compressor() -> &'static Mutex<SharedCompressor> {
    COMPRESSOR.get_or_init(|| {
        let mut optimizer = Optimizer::default()
            .with_counter(Arc::new(Tiktoken::cl100k()))
            .with_text_proposer(Box::new(text::ReadableLines));
        optimizer.set_offload_allowed(false);
        let path = std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join(".local/share/cpa-secondwind/metrics.json"));
        let loaded = path
            .as_ref()
            .ok_or_else(|| "HOME is unset".to_owned())
            .and_then(|path| load_metrics(path));
        let (metrics, rewrite_latency, metrics_path, persistence_error) = match loaded {
            Ok((metrics, latency)) => (metrics, latency, path, None),
            Err(error) => {
                eprintln!("secondwind: metrics could not be loaded: {error}");
                // Preserve an unreadable file; compression can continue without overwriting it.
                (
                    Metrics::default(),
                    Histogram::new(3).expect("rewrite latency histogram"),
                    None,
                    Some(error),
                )
            }
        };
        Mutex::new(SharedCompressor {
            optimizer,
            metrics,
            rewrite_latency,
            metrics_path,
            persistence_error,
        })
    })
}

fn compress_text(
    value: &mut Value,
    optimizer: &mut Optimizer,
    metrics: &mut Metrics,
    tool: bool,
) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    let before = optimizer.count(text) as u64;
    metrics.outputs += 1;
    metrics.tokens_before += before;
    if let Some(rewrite) = text::rewrite(text, optimizer, tool) {
        let after = optimizer.count(&rewrite.wire) as u64;
        metrics.tokens_after += after;
        metrics.rewritten_outputs += 1;
        let method = rewrite.methods.into_iter().collect::<Vec<_>>().join("+");
        let entry = metrics.savings_by_method.entry(method).or_default();
        entry.saved_tokens += before - after;
        entry.rewritten_blocks += 1;
        *value = Value::String(rewrite.wire);
        true
    } else {
        metrics.tokens_after += before;
        false
    }
}

fn compress_content(
    value: &mut Value,
    optimizer: &mut Optimizer,
    metrics: &mut Metrics,
    tool: bool,
) -> bool {
    if value.is_string() {
        return compress_text(value, optimizer, metrics, tool);
    }
    let Some(parts) = value.as_array_mut() else {
        return false;
    };
    let mut changed = false;
    for part in parts {
        if matches!(
            part["type"].as_str(),
            Some("text" | "input_text" | "output_text")
        ) {
            changed |= compress_text(&mut part["text"], optimizer, metrics, tool);
        }
    }
    changed
}

fn rewrite_payload(request: &mut Value, optimizer: &mut Optimizer, metrics: &mut Metrics) -> bool {
    let mut changed = false;
    if request.get("input").is_some_and(Value::is_string) {
        changed |= compress_content(&mut request["input"], optimizer, metrics, false);
    }
    if let Some(input) = request.get_mut("input").and_then(Value::as_array_mut) {
        for item in input {
            if matches!(
                item["type"].as_str(),
                Some("function_call_output" | "custom_tool_call_output")
            ) {
                changed |= compress_content(&mut item["output"], optimizer, metrics, true);
            } else if item["role"] == "user" {
                changed |= compress_content(&mut item["content"], optimizer, metrics, false);
            }
        }
    }
    if let Some(messages) = request.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages {
            if message["role"] == "tool" {
                changed |= compress_content(&mut message["content"], optimizer, metrics, true);
            } else if message["role"] == "user" {
                changed |= compress_content(&mut message["content"], optimizer, metrics, false);
                if let Some(parts) = message["content"].as_array_mut() {
                    for part in parts {
                        if part["type"] == "tool_result" {
                            changed |=
                                compress_content(&mut part["content"], optimizer, metrics, true);
                        }
                    }
                }
            }
        }
    }
    changed
}

fn rewrite(body: &[u8]) -> Result<Option<Vec<u8>>, String> {
    let started = Instant::now();
    let mut request: Value = serde_json::from_slice(body).map_err(|e| e.to_string())?;
    let mut guard = compressor().lock().map_err(|e| e.to_string())?;
    let SharedCompressor {
        optimizer,
        metrics,
        rewrite_latency,
        metrics_path,
        persistence_error,
    } = &mut *guard;
    metrics.requests += 1;
    let model = request["model"].as_str().unwrap_or("unknown").to_owned();
    let tokens_before = metrics.tokens_before;
    let tokens_after = metrics.tokens_after;
    if let Some(model) = request["model"].as_str() {
        optimizer.set_model(model);
    }
    let changed = rewrite_payload(&mut request, optimizer, metrics);
    let result = if changed {
        let body = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
        metrics.rewritten_requests += 1;
        let saved = (metrics.tokens_before - tokens_before)
            .saturating_sub(metrics.tokens_after - tokens_after);
        *metrics.saved_tokens_by_model.entry(model).or_default() += saved;
        rewrite_latency
            .record(started.elapsed().as_micros().max(1) as u64)
            .map_err(|e| e.to_string())?;
        Some(body)
    } else {
        None
    };
    if let Some(path) = metrics_path {
        let error = save_metrics(path, metrics, rewrite_latency).err();
        if error != *persistence_error {
            if let Some(error) = &error {
                eprintln!("secondwind: metrics could not be saved: {error}");
            }
        }
        *persistence_error = error;
    }
    Ok(result)
}

#[derive(Deserialize)]
struct InterceptRequest {
    #[serde(rename = "Body")]
    body: String,
}

fn dispatch(method: &str, request: &[u8]) -> Result<Value, String> {
    match method {
        "plugin.register" | "plugin.reconfigure" => Ok(json!({
            "schema_version": 1,
            "metadata": {"Name": "Secondwind", "Version": env!("CARGO_PKG_VERSION"), "Author": "cgasgarth", "GitHubRepository": "https://github.com/cgasgarth/codex"},
            "capabilities": {"request_interceptor": true, "management_api": true}
        })),
        "management.register" => {
            let context: Value = serde_json::from_slice(request).map_err(|e| e.to_string())?;
            let base = context["BasePath"]
                .as_str()
                .ok_or("Missing management API base path")?;
            let _ = STATS_URL.set(format!("{base}/plugins/cpa-secondwind/stats"));
            Ok(json!({
                "routes": [{"Method": "GET", "Path": "/plugins/cpa-secondwind/stats"}],
                "resources": [{"Path": "/dashboard", "Menu": "Secondwind", "Description": "Lossless structured-text token savings"}]
            }))
        }
        "management.handle" => {
            let request: Value = serde_json::from_slice(request).map_err(|e| e.to_string())?;
            if request["Path"]
                .as_str()
                .is_some_and(|p| p.ends_with("/stats"))
            {
                let guard = compressor().lock().map_err(|e| e.to_string())?;
                let mut stats = serde_json::to_value(&guard.metrics).map_err(|e| e.to_string())?;
                stats["persistence_error"] = json!(guard.persistence_error);
                let tracked: u64 = guard
                    .metrics
                    .savings_by_method
                    .values()
                    .map(|m| m.saved_tokens)
                    .sum();
                stats["method_tracked_tokens"] = json!(tracked);
                stats["method_untracked_tokens"] = json!((guard.metrics.tokens_before
                    - guard.metrics.tokens_after)
                    .saturating_sub(tracked));
                let prices = input_prices();
                let mut savings = 0.0;
                let mut unpriced_tokens = 0;
                let models: Vec<Value> = guard.metrics.saved_tokens_by_model.iter().map(|(model, tokens)| {
                    let rate = prices.usd_per_million_tokens.get(model);
                    let estimate = rate.map(|rate| *tokens as f64 * rate / 1_000_000.0);
                    if let Some(estimate) = estimate {
                        savings += estimate;
                    } else {
                        unpriced_tokens += tokens;
                    }
                    json!({"model": model, "saved_tokens": tokens, "input_usd_per_million": rate, "estimated_savings_usd": estimate})
                }).collect();
                stats["estimated_savings_usd"] = json!(savings);
                stats["unpriced_saved_tokens"] = json!(unpriced_tokens);
                stats["model_savings"] = json!(models);
                stats["prices_checked_on"] = json!(prices.checked_on);
                stats["price_sources"] = json!(prices.sources);
                for (field, quantile) in [("rewrite_median_ms", 0.5), ("rewrite_p99_ms", 0.99)] {
                    stats[field] = if guard.rewrite_latency.is_empty() {
                        Value::Null
                    } else {
                        json!(guard.rewrite_latency.value_at_quantile(quantile) as f64 / 1000.0)
                    };
                }
                let body = serde_json::to_vec(&stats).map_err(|e| e.to_string())?;
                Ok(management_response("application/json", body))
            } else {
                let endpoint = STATS_URL.get().ok_or("Management API not registered")?;
                let page = include_str!("dashboard.html").replace(
                    "__STATS_URL__",
                    &serde_json::to_string(endpoint).map_err(|e| e.to_string())?,
                );
                Ok(management_response(
                    "text/html; charset=utf-8",
                    page.into_bytes(),
                ))
            }
        }
        "request.intercept_after" => {
            let request: InterceptRequest =
                serde_json::from_slice(request).map_err(|e| e.to_string())?;
            let body = STANDARD.decode(request.body).map_err(|e| e.to_string())?;
            match rewrite(&body) {
                Ok(Some(body)) => Ok(json!({"Body": STANDARD.encode(body)})),
                Ok(None) => Ok(json!({})),
                Err(error) => {
                    eprintln!("secondwind: request unchanged: {error}");
                    Ok(json!({}))
                }
            }
        }
        "request.intercept_before" | "request.completed" => Ok(json!({})),
        _ => Err(format!("unsupported method: {method}")),
    }
}

fn management_response(content_type: &str, body: Vec<u8>) -> Value {
    json!({"StatusCode": 200, "Headers": {"Content-Type": [content_type], "Cache-Control": ["no-store"]}, "Body": STANDARD.encode(body)})
}

// CLIProxyAPI's published C ABI. Returned buffers use boxed slices for exact allocation sizes.
#[repr(C)]
pub struct Buffer {
    ptr: *mut u8,
    len: usize,
}
#[repr(C)]
pub struct HostApi {
    abi_version: u32,
    host_ctx: *mut c_void,
    call: Option<
        unsafe extern "C" fn(*mut c_void, *const c_char, *const u8, usize, *mut Buffer) -> i32,
    >,
    free_buffer: Option<unsafe extern "C" fn(*mut c_void, usize)>,
}
#[repr(C)]
pub struct PluginApi {
    abi_version: u32,
    call: Option<unsafe extern "C" fn(*const c_char, *const u8, usize, *mut Buffer) -> i32>,
    free_buffer: Option<unsafe extern "C" fn(*mut c_void, usize)>,
    shutdown: Option<unsafe extern "C" fn()>,
}

#[no_mangle]
pub unsafe extern "C" fn cliproxy_plugin_init(host: *const HostApi, plugin: *mut PluginApi) -> i32 {
    if host.is_null() || plugin.is_null() || (*host).abi_version != 1 {
        return 1;
    }
    *plugin = PluginApi {
        abi_version: 1,
        call: Some(call),
        free_buffer: Some(free_buffer),
        shutdown: Some(shutdown),
    };
    0
}

unsafe extern "C" fn call(
    method: *const c_char,
    request: *const u8,
    len: usize,
    output: *mut Buffer,
) -> i32 {
    if output.is_null() {
        return 1;
    }
    *output = Buffer {
        ptr: ptr::null_mut(),
        len: 0,
    };
    if method.is_null() || request.is_null() {
        return 1;
    }
    let result = std::panic::catch_unwind(|| {
        CStr::from_ptr(method)
            .to_str()
            .map_err(|e| e.to_string())
            .and_then(|method| dispatch(method, slice::from_raw_parts(request, len)))
    })
    .unwrap_or_else(|_| Err("plugin panic".into()));
    let envelope = match result {
        Ok(result) => json!({"ok": true, "result": result}),
        Err(message) => {
            json!({"ok": false, "error": {"code": "secondwind_error", "message": message}})
        }
    };
    let bytes = serde_json::to_vec(&envelope)
        .expect("JSON envelope")
        .into_boxed_slice();
    let len = bytes.len();
    *output = Buffer {
        ptr: Box::into_raw(bytes) as *mut u8,
        len,
    };
    0
}

unsafe extern "C" fn free_buffer(buffer: *mut c_void, len: usize) {
    if !buffer.is_null() {
        drop(Box::from_raw(ptr::slice_from_raw_parts_mut(
            buffer as *mut u8,
            len,
        )));
    }
}
unsafe extern "C" fn shutdown() {}

#[cfg(test)]
mod tests {
    use super::*;

    fn data() -> String {
        serde_json::to_string_pretty(
            &(0..40)
                .map(|i| json!({"id": i, "name": format!("row-{i}"), "active": true}))
                .collect::<Vec<_>>(),
        )
        .unwrap()
    }

    fn optimizer() -> Optimizer {
        let mut optimizer = Optimizer::default()
            .with_counter(Arc::new(Tiktoken::cl100k()))
            .with_text_proposer(Box::new(text::ReadableLines));
        optimizer.set_offload_allowed(false);
        optimizer
    }

    #[test]
    fn embedded_data_preserves_surrounding_text_and_code_fences() {
        let data = data();
        let code = format!("```javascript\nconst records = {data};\n```\n");
        let before = format!("Header stays.\n\n{code}\n```json\n{data}\n```\n\nFooter stays.");
        let after = text::rewrite(&before, &mut optimizer(), false)
            .unwrap()
            .wire;
        assert!(after.starts_with("Header stays.\n\n"));
        assert!(after.contains(&code));
        assert!(after.contains("```text\n"));
        assert!(after.ends_with("\n\nFooter stays."));
        let plain = format!("Header stays.\n{data}\nFooter stays.");
        let after = text::rewrite(&plain, &mut optimizer(), false).unwrap().wire;
        assert!(after.starts_with("Header stays.\n"));
        assert!(after.ends_with("\nFooter stays."));
        let paths = (0..30)
            .map(|i| format!("src/components/records/file-{i}.rs"))
            .collect::<Vec<_>>()
            .join("\n");
        let mixed = format!("Header stays.\n\n{paths}\n\nFooter stays.");
        let after = text::rewrite(&mixed, &mut optimizer(), true).unwrap().wire;
        assert!(after.starts_with("Header stays.\n\n"));
        assert!(after.ends_with("\n\nFooter stays."));
    }

    #[test]
    fn protocol_routing_preserves_instructions_tool_calls_and_images() {
        let data = data();
        let text = format!("Inspect this data:\n{data}\nKeep this footer.");
        for mut request in [
            json!({"input":[{"role":"developer","content":data},{"role":"assistant","content":data},{"role":"user","content":[{"type":"input_text","text":text},{"type":"input_image","image_url":"data:image/png;base64,example"}]},{"type":"function_call","name":"lookup","call_id":"one","arguments":data},{"type":"function_call_output","call_id":"one","output":text}],"tools":[{"name":"lookup","parameters":{"description":data}}],"instructions":data}),
            json!({"messages":[{"role":"system","content":data},{"role":"assistant","content":data,"tool_calls":[{"id":"one","function":{"name":"lookup","arguments":data}}]},{"role":"user","content":text},{"role":"tool","tool_call_id":"one","content":text}],"tools":[{"name":"lookup","parameters":{"description":data}}]}),
            json!({"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"one","name":"lookup","input":{"data":data}}]},{"role":"user","content":[{"type":"text","text":text},{"type":"tool_result","tool_use_id":"one","content":[{"type":"text","text":text},{"type":"image","source":{"data":"example"}}]}]}],"system":data}),
        ] {
            let original = request.clone();
            let mut metrics = Metrics::default();
            assert!(rewrite_payload(
                &mut request,
                &mut optimizer(),
                &mut metrics
            ));
            assert!(metrics.rewritten_outputs >= 2);
            assert_eq!(request["tools"], original["tools"]);
            assert_eq!(request["instructions"], original["instructions"]);
            assert_eq!(request["system"], original["system"]);
            for field in ["input", "messages"] {
                if let Some(items) = request[field].as_array() {
                    for (i, item) in items.iter().enumerate() {
                        let old = &original[field][i];
                        if item["role"] == "assistant"
                            || item["role"] == "system"
                            || item["role"] == "developer"
                            || item["type"] == "function_call"
                        {
                            assert_eq!(item, old);
                        }
                        for id in ["call_id", "tool_call_id"] {
                            assert_eq!(item[id], old[id]);
                        }
                        if let Some(parts) = item["content"].as_array() {
                            for (j, part) in parts.iter().enumerate() {
                                assert_eq!(part["tool_use_id"], old["content"][j]["tool_use_id"]);
                                if part["type"] == "input_image" {
                                    assert_eq!(part, &old["content"][j]);
                                }
                                if part["type"] == "tool_result" {
                                    assert_eq!(part["content"][1], old["content"][j]["content"][1]);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn nested_command_outputs_keep_envelope_metadata() {
        let paths = (0..30)
            .map(|i| format!("src/components/records/file-{i}.rs"))
            .collect::<Vec<_>>()
            .join("\n");
        let original = json!({"status":"fulfilled","value":{"chunk_id":"one","exit_code":7,"wall_time_seconds":0.2,"output":paths,"extra":"keep"}});
        let raw = serde_json::to_string(&original).unwrap();
        let wire = text::rewrite(&raw, &mut optimizer(), true).unwrap().wire;
        let mut after: Value = serde_json::from_str(&wire).unwrap();
        assert_ne!(after["value"]["output"], original["value"]["output"]);
        after["value"]["output"] = original["value"]["output"].clone();
        assert_eq!(after, original);
    }

    #[test]
    fn compact_json_preserves_fence_language_and_leaves_ambiguous_keys_unchanged() {
        let raw = "Header.\n```json\n{\n  \"enabled\": true,\n  \"limit\": 123456789012345678901234567890,\n  \"note\": \"keep spacing  inside strings\"\n}\n```\nFooter.";
        let wire = text::rewrite(raw, &mut optimizer(), false).unwrap().wire;
        assert!(wire.starts_with("Header.\n```json\n{"));
        assert!(wire.ends_with("\n```\nFooter."));
        assert!(wire.contains("123456789012345678901234567890"));
        assert!(wire.contains("keep spacing  inside strings"));
        assert!(text::rewrite("{\"key\":1,\"key\":2}", &mut optimizer(), false).is_none());
    }

    #[test]
    fn line_dictionary_is_limited_to_tool_results_outside_code_fences() {
        let raw = (0..16).map(|i| format!("service: service-{i}\n  restart: always\n  healthcheck:\n    interval: 30s\n    retries: 3\n  cache: warm\n  port: {}",8000+i)).collect::<Vec<_>>().join("\n");
        let mut request = json!({"messages":[{"role":"user","content":raw},{"role":"assistant","content":raw},{"role":"tool","tool_call_id":"one","content":raw}]});
        let original = request.clone();
        assert!(rewrite_payload(
            &mut request,
            &mut optimizer(),
            &mut Metrics::default()
        ));
        assert_eq!(request["messages"][0], original["messages"][0]);
        assert_eq!(request["messages"][1], original["messages"][1]);
        assert!(request["messages"][2]["content"]
            .as_str()
            .unwrap()
            .starts_with("Lossless line dictionary:"));
        let fenced = format!("```rust\n{raw}\n```\n");
        assert!(text::rewrite(&fenced, &mut optimizer(), true).is_none());
    }

    #[test]
    fn method_totals_count_only_accepted_outer_blocks() {
        let lines = (0..16).map(|i| format!("service: service-{i}\n  restart: always\n  healthcheck:\n    interval: 30s\n    retries: 3\n  cache: warm\n  port: {}",8000+i)).collect::<Vec<_>>().join("\n");
        let nested = serde_json::to_string_pretty(&json!({"exit_code":0,"output":lines})).unwrap();
        let whitespace =
            "{\n  \"enabled\": true,\n  \"limit\": 123,\n  \"note\": \"keep spaces  inside\"\n}";
        let mut request = json!({"messages":[{"role":"tool","content":nested},{"role":"user","content":whitespace},{"role":"user","content":data()}]});
        let mut metrics = Metrics::default();
        assert!(rewrite_payload(
            &mut request,
            &mut optimizer(),
            &mut metrics
        ));
        assert_eq!(
            metrics
                .savings_by_method
                .values()
                .map(|m| m.saved_tokens)
                .sum::<u64>(),
            metrics.tokens_before - metrics.tokens_after
        );
        assert_eq!(
            metrics
                .savings_by_method
                .values()
                .map(|m| m.rewritten_blocks)
                .sum::<u64>(),
            metrics.rewritten_outputs
        );
        assert_eq!(metrics.savings_by_method.len(), 3);
        assert!(metrics.savings_by_method.contains_key("json_whitespace"));
        assert!(metrics
            .savings_by_method
            .keys()
            .any(|k| k.contains("readable_lines") && k.contains("tool_envelope")));
    }

    #[test]
    fn metrics_survive_reload_and_file_replacement() {
        let path = std::env::temp_dir().join(format!(
            "secondwind-metrics-test-{}.json",
            std::process::id()
        ));
        let (mut metrics, mut latency) = load_metrics(&path).unwrap();
        metrics.requests = 3;
        metrics.tokens_before = 1000;
        metrics.tokens_after = 600;
        metrics
            .saved_tokens_by_model
            .insert("example-model".into(), 400);
        metrics.savings_by_method.insert(
            "json_whitespace".into(),
            MethodSavings {
                saved_tokens: 400,
                rewritten_blocks: 2,
            },
        );
        latency.record_n(125, 2).unwrap();
        latency.record(9000).unwrap();
        save_metrics(&path, &metrics, &latency).unwrap();
        let (mut restored, restored_latency) = load_metrics(&path).unwrap();
        assert_eq!(restored.requests, 3);
        assert_eq!(restored.tokens_before - restored.tokens_after, 400);
        assert_eq!(restored.saved_tokens_by_model["example-model"], 400);
        assert_eq!(
            restored.savings_by_method["json_whitespace"].saved_tokens,
            400
        );
        assert_eq!(
            restored.savings_by_method["json_whitespace"].rewritten_blocks,
            2
        );
        assert_eq!(restored_latency.len(), latency.len());
        for q in [0.5, 0.99] {
            assert_eq!(
                restored_latency.value_at_quantile(q),
                latency.value_at_quantile(q)
            );
        }
        restored.requests += 1;
        save_metrics(&path, &restored, &restored_latency).unwrap();
        assert_eq!(load_metrics(&path).unwrap().0.requests, 4);
        fs::write(&path, b"invalid json").unwrap();
        assert!(load_metrics(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"invalid json");
        fs::remove_file(path).unwrap();
    }
}
