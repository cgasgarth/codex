use secondwind_optimize::{Optimizer, Outcome};
use serde_json::Value;
use std::collections::BTreeSet;

// Carry only the chosen candidate's methods. Count savings once, at the outer
// text-block boundary, so nested results and competing candidates cannot inflate totals.
pub struct Rewrite {
    pub wire: String,
    pub methods: BTreeSet<&'static str>,
}

impl Rewrite {
    fn plain(raw: &str) -> Self {
        Self {
            wire: raw.to_owned(),
            methods: BTreeSet::new(),
        }
    }

    fn method(wire: String, method: &'static str) -> Self {
        Self {
            wire,
            methods: BTreeSet::from([method]),
        }
    }

    fn append(&mut self, other: Self) {
        self.wire.push_str(&other.wire);
        self.methods.extend(other.methods);
    }
}

const LINE_LEGEND: &str = "Lossless line dictionary: after ==, each entire line that is a legend code expands to its exact legend line. Other lines stay literal. Preserve line order and indentation.\n";

// All values stay inline. Secondwind proves this proposer's inverse and prices
// the complete wire, including the explanation used in the model-readability checks.
pub struct ReadableLines;

impl secondwind_optimize::transform::TextProposer for ReadableLines {
    fn id(&self) -> &'static str {
        "readable_lines"
    }

    fn encode(&self, raw: &str) -> Option<String> {
        if raw.starts_with(LINE_LEGEND) {
            return None;
        }
        secondwind_optimize::lines::encode(raw).map(|wire| format!("{LINE_LEGEND}{wire}"))
    }

    fn decode(&self, wire: &str) -> Option<String> {
        secondwind_optimize::lines::decode(wire.strip_prefix(LINE_LEGEND)?)
    }
}

fn compress(raw: &str, optimizer: &mut Optimizer) -> Option<Rewrite> {
    let structured = match optimizer.compress_block(raw) {
        Outcome::Compressed {
            wire, transform, ..
        } => Some(Rewrite::method(wire, transform)),
        _ => None,
    };
    // JSON formatting is not data. Keep every parsed value and numeric lexeme;
    // reject duplicate keys before serde could resolve them with last-key-wins.
    let compact = serde_json::from_str::<Value>(raw)
        .ok()
        .filter(|v| v.is_array() || v.is_object())
        .filter(|_| !secondwind_optimize::atom::has_duplicate_keys(raw))
        .and_then(|v| serde_json::to_string(&v).ok())
        .filter(|wire| wire != raw)
        .map(|wire| Rewrite::method(wire, "json_whitespace"));
    if structured.is_none() && compact.is_none() {
        return None;
    }
    let before = optimizer.count(raw);
    structured
        .into_iter()
        .chain(compact)
        .filter(|rewrite| optimizer.count(&rewrite.wire) < before)
        .min_by_key(|rewrite| optimizer.count(&rewrite.wire))
}

fn envelope(
    value: &mut Value,
    optimizer: &mut Optimizer,
    methods: &mut BTreeSet<&'static str>,
) -> bool {
    fn text(
        value: &mut Value,
        optimizer: &mut Optimizer,
        methods: &mut BTreeSet<&'static str>,
    ) -> bool {
        let Some(raw) = value.as_str() else {
            return false;
        };
        let Some(rewrite) = rewrite(raw, optimizer, true) else {
            return false;
        };
        methods.extend(rewrite.methods);
        *value = Value::String(rewrite.wire);
        true
    }
    if let Some(items) = value.as_array_mut() {
        let mut changed = false;
        for item in items {
            changed |= envelope(item, optimizer, methods);
        }
        return changed;
    }
    let mut changed = false;
    if let Some(parts) = value.get_mut("content").and_then(Value::as_array_mut) {
        for part in parts {
            if part["type"] == "text" {
                changed |= text(&mut part["text"], optimizer, methods);
            }
        }
    }
    if value.get("chunk_id").is_some()
        || value.get("wall_time_seconds").is_some()
        || value.get("exit_code").is_some()
    {
        if let Some(output) = value.get_mut("output") {
            changed |= text(output, optimizer, methods);
        }
    }
    if value["status"] == "fulfilled" {
        changed |= envelope(&mut value["value"], optimizer, methods);
    }
    if value["ok"] == true {
        changed |= envelope(&mut value["result"], optimizer, methods);
    }
    changed
}

fn json(raw: &str, optimizer: &mut Optimizer, tool: bool) -> Option<Rewrite> {
    let mut best = compress(raw, optimizer);
    if tool && !secondwind_optimize::atom::has_duplicate_keys(raw) {
        if let Ok(mut value) = serde_json::from_str::<Value>(raw) {
            let mut methods = BTreeSet::new();
            if envelope(&mut value, optimizer, &mut methods) {
                let nested = serde_json::to_string(&value).ok()?;
                let mut rewrite =
                    compress(&nested, optimizer).unwrap_or_else(|| Rewrite::plain(&nested));
                rewrite.methods.extend(methods);
                rewrite.methods.insert("tool_envelope");
                let limit = optimizer.count(best.as_ref().map_or(raw, |r| &r.wire));
                if optimizer.count(&rewrite.wire) < limit {
                    best = Some(rewrite);
                }
            }
        }
    }
    best
}

// Keep paragraph separators in place. Only tool results use the text codecs;
// user messages are eligible for structured JSON data, not prose rewrites.
fn paragraphs(raw: &str, optimizer: &mut Optimizer, tool: bool) -> Rewrite {
    if !tool {
        return Rewrite::plain(raw);
    }
    let mut output = Rewrite::plain("");
    for part in raw.split_inclusive("\n\n") {
        let (body, separator) = part
            .strip_suffix("\n\n")
            .map_or((part, ""), |body| (body, "\n\n"));
        output.append(compress(body, optimizer).unwrap_or_else(|| Rewrite::plain(body)));
        output.wire.push_str(separator);
    }
    output
}

fn json_data(raw: &str) -> bool {
    matches!(
        serde_json::from_str::<Value>(raw),
        Ok(Value::Array(_) | Value::Object(_))
    )
}

fn unfenced(raw: &str, optimizer: &mut Optimizer, tool: bool) -> Rewrite {
    let mut output = Rewrite::plain("");
    let mut copied = 0;
    let mut offset = 0;
    while offset < raw.len() {
        let line_end = raw[offset..].find('\n').map_or(raw.len(), |n| offset + n);
        let line = &raw[offset..line_end];
        let start = offset + line.len() - line.trim_start_matches([' ', '\t']).len();
        if raw[start..].starts_with(['{', '[']) {
            // serde owns JSON parsing, including escapes and nested delimiters.
            let mut stream = serde_json::Deserializer::from_str(&raw[start..]).into_iter::<Value>();
            if matches!(stream.next(), Some(Ok(Value::Array(_) | Value::Object(_)))) {
                let end = start + stream.byte_offset();
                let tail_end = raw[end..].find('\n').map_or(raw.len(), |n| end + n);
                if raw[end..tail_end].trim().is_empty() {
                    if let Some(wire) = json(&raw[start..end], optimizer, tool) {
                        output.append(paragraphs(&raw[copied..start], optimizer, tool));
                        output.append(wire);
                        copied = end;
                    }
                    offset = (tail_end + 1).min(raw.len());
                    continue;
                }
            }
        }
        offset = (line_end + 1).min(raw.len());
    }
    output.append(paragraphs(&raw[copied..], optimizer, tool));
    // Keep the whole-block result when it is cheaper than its separate sections.
    if tool || json_data(raw) {
        if let Some(whole) = compress(raw, optimizer) {
            if optimizer.count(&whole.wire) < optimizer.count(&output.wire) {
                return whole;
            }
        }
    }
    output
}

fn fence(line: &str) -> Option<(&str, &str)> {
    let trimmed = line.trim_start_matches(' ');
    if line.len() - trimmed.len() > 3 {
        return None;
    }
    let marker = trimmed.as_bytes().first().copied()?;
    if !matches!(marker, b'`' | b'~') {
        return None;
    }
    let len = trimmed.bytes().take_while(|b| *b == marker).count();
    (len >= 3).then(|| (&trimmed[..len], trimmed[len..].trim()))
}

// Programming-language fences and unclosed fences are kept intact. JSON fences
// contain data; change their label to text when the library emits its table wire.
pub fn rewrite(raw: &str, optimizer: &mut Optimizer, tool: bool) -> Option<Rewrite> {
    if json_data(raw) {
        return json(raw, optimizer, tool);
    }
    let mut output = Rewrite::plain("");
    let mut lines = raw.split_inclusive('\n');
    let mut outside = String::new();
    while let Some(line) = lines.next() {
        let Some((marker, language)) = fence(line) else {
            outside.push_str(line);
            continue;
        };
        output.append(unfenced(&outside, optimizer, tool));
        outside.clear();
        let mut body = String::new();
        let mut closing = None;
        for next in lines.by_ref() {
            if fence(next).is_some_and(|(end, info)| {
                info.is_empty() && end.len() >= marker.len() && end.starts_with(&marker[..1])
            }) {
                closing = Some(next);
                break;
            }
            body.push_str(next);
        }
        let wire = closing
            .filter(|_| language.eq_ignore_ascii_case("json") && json_data(&body))
            .and_then(|_| json(&body, optimizer, tool));
        if let Some(wire) = wire {
            if json_data(&wire.wire) {
                output.wire.push_str(line);
            } else {
                output.wire.push_str(&line.replacen(language, "text", 1));
            }
            output.append(wire);
            if !output.wire.ends_with('\n') {
                output.wire.push('\n');
            }
        } else {
            output.wire.push_str(line);
            output.wire.push_str(&body);
        }
        if let Some(closing) = closing {
            output.wire.push_str(closing);
        }
    }
    output.append(unfenced(&outside, optimizer, tool));
    (output.wire != raw && optimizer.count(&output.wire) < optimizer.count(raw)).then_some(output)
}
