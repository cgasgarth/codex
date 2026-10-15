use secondwind_optimize::{Optimizer, Outcome};
use serde_json::Value;

fn compress(raw: &str, optimizer: &mut Optimizer) -> Option<String> {
    match optimizer.compress_block(raw) {
        Outcome::Compressed { wire, .. } => Some(wire),
        _ => None,
    }
}

// Keep paragraph separators in place. Only tool results use the text codecs;
// user messages are eligible for structured JSON data, not prose rewrites.
fn paragraphs(raw: &str, optimizer: &mut Optimizer, tool: bool) -> String {
    if !tool {
        return raw.to_owned();
    }
    raw.split_inclusive("\n\n")
        .map(|part| {
            let (body, separator) = part
                .strip_suffix("\n\n")
                .map_or((part, ""), |body| (body, "\n\n"));
            format!(
                "{}{separator}",
                compress(body, optimizer).as_deref().unwrap_or(body)
            )
        })
        .collect()
}

fn json_data(raw: &str) -> bool {
    matches!(
        serde_json::from_str::<Value>(raw),
        Ok(Value::Array(_) | Value::Object(_))
    )
}

fn unfenced(raw: &str, optimizer: &mut Optimizer, tool: bool) -> String {
    let mut output = String::new();
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
                    if let Some(wire) = compress(&raw[start..end], optimizer) {
                        output.push_str(&paragraphs(&raw[copied..start], optimizer, tool));
                        output.push_str(&wire);
                        copied = end;
                    }
                    offset = (tail_end + 1).min(raw.len());
                    continue;
                }
            }
        }
        offset = (line_end + 1).min(raw.len());
    }
    output.push_str(&paragraphs(&raw[copied..], optimizer, tool));
    // Keep the whole-block result when it is cheaper than its separate sections.
    if tool || json_data(raw) {
        if let Some(whole) = compress(raw, optimizer) {
            if optimizer.count(&whole) < optimizer.count(&output) {
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
pub fn rewrite(raw: &str, optimizer: &mut Optimizer, tool: bool) -> Option<String> {
    if json_data(raw) {
        return compress(raw, optimizer);
    }
    let mut output = String::new();
    let mut lines = raw.split_inclusive('\n');
    let mut outside = String::new();
    while let Some(line) = lines.next() {
        let Some((marker, language)) = fence(line) else {
            outside.push_str(line);
            continue;
        };
        output.push_str(&unfenced(&outside, optimizer, tool));
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
            .and_then(|_| compress(&body, optimizer));
        if let Some(wire) = wire {
            output.push_str(&line.replacen(language, "text", 1));
            output.push_str(&wire);
            if !wire.ends_with('\n') {
                output.push('\n');
            }
        } else {
            output.push_str(line);
            output.push_str(&body);
        }
        if let Some(closing) = closing {
            output.push_str(closing);
        }
    }
    output.push_str(&unfenced(&outside, optimizer, tool));
    (output != raw && optimizer.count(&output) < optimizer.count(raw)).then_some(output)
}
