use base64::{engine::general_purpose::STANDARD, Engine};
use hdrhistogram::Histogram;
use secondwind_optimize::{tokens::Tiktoken, Optimizer, Outcome};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    ffi::{c_char, c_void, CStr},
    ptr, slice,
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};

// One compressor for the entire proxy. The lock protects Secondwind's mutable API.
struct SharedCompressor {
    optimizer: Optimizer,
    metrics: Metrics,
    rewrite_latency: Histogram<u64>,
}

#[derive(Default, Serialize)]
struct Metrics {
    requests: u64,
    rewritten_requests: u64,
    outputs: u64,
    rewritten_outputs: u64,
    tokens_before: u64,
    tokens_after: u64,
}
// Secondwind's Transform trait lacks Send. This instance contains only its built-in
// owned transforms and the thread-safe tokenizer; all access is under this mutex.
unsafe impl Send for SharedCompressor {}
static COMPRESSOR: OnceLock<Mutex<SharedCompressor>> = OnceLock::new();
static STATS_URL: OnceLock<String> = OnceLock::new();

fn compressor() -> &'static Mutex<SharedCompressor> {
    COMPRESSOR.get_or_init(|| {
        let mut optimizer = Optimizer::default().with_counter(Arc::new(Tiktoken::cl100k()));
        optimizer.set_offload_allowed(false);
        Mutex::new(SharedCompressor {
            optimizer,
            metrics: Metrics::default(),
            rewrite_latency: Histogram::new(3).expect("rewrite latency histogram"),
        })
    })
}

fn compress_text(value: &mut Value, optimizer: &mut Optimizer, metrics: &mut Metrics) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    let before = optimizer.count(text) as u64;
    metrics.outputs += 1;
    metrics.tokens_before += before;
    if let Outcome::Compressed { wire, .. } = optimizer.compress_block(text) {
        metrics.tokens_after += optimizer.count(&wire) as u64;
        metrics.rewritten_outputs += 1;
        *value = Value::String(wire);
        true
    } else {
        metrics.tokens_after += before;
        false
    }
}

fn compress_content(value: &mut Value, optimizer: &mut Optimizer, metrics: &mut Metrics) -> bool {
    if value.is_string() {
        return compress_text(value, optimizer, metrics);
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
            changed |= compress_text(&mut part["text"], optimizer, metrics);
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
    } = &mut *guard;
    metrics.requests += 1;
    if let Some(model) = request["model"].as_str() {
        optimizer.set_model(model);
    }
    let mut changed = false;
    if let Some(input) = request.get_mut("input").and_then(Value::as_array_mut) {
        for item in input {
            if matches!(
                item["type"].as_str(),
                Some("function_call_output" | "custom_tool_call_output")
            ) {
                changed |= compress_content(&mut item["output"], optimizer, metrics);
            }
        }
    }
    if let Some(messages) = request.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages {
            if message["role"] == "tool" {
                changed |= compress_content(&mut message["content"], optimizer, metrics);
            } else if let Some(parts) = message["content"].as_array_mut() {
                for part in parts {
                    if part["type"] == "tool_result" {
                        changed |= compress_content(&mut part["content"], optimizer, metrics);
                    }
                }
            }
        }
    }
    if changed {
        let body = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
        metrics.rewritten_requests += 1;
        rewrite_latency
            .record(started.elapsed().as_micros().max(1) as u64)
            .map_err(|e| e.to_string())?;
        Ok(Some(body))
    } else {
        Ok(None)
    }
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
            "metadata": {"Name": "Secondwind", "Version": "0.3.0", "Author": "cgasgarth", "GitHubRepository": "https://github.com/cgasgarth/codex"},
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
                "resources": [{"Path": "/dashboard", "Menu": "Secondwind", "Description": "Lossless tool-output token savings"}]
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
