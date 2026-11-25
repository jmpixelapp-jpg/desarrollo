//! Microbenchmark reproducible de ediciones puntuales RopeText vs String.
//! Ejecutar con: cargo bench -p motor-literario-core --bench rope_edits
use motor_literario_core::{affected_paragraph_range, affected_paragraph_range_rope, RopeText};
use motor_literario_core::{JsonRpcServer, LiveEngineWorker, PendingChange, PersistentLiveEngine};
use std::fs;
use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};
use std::hint::black_box;
use std::time::Instant;

fn percentile(samples: &mut [u128], percentile: usize) -> u128 {
    if samples.is_empty() {
        return 0;
    }
    samples.sort_unstable();
    let index = ((samples.len() * percentile + 99) / 100).saturating_sub(1);
    samples[index.min(samples.len() - 1)]
}
fn report(label: &str, mut samples: Vec<u128>) {
    let p50 = percentile(&mut samples, 50);
    let p95 = percentile(&mut samples, 95);
    let p99 = percentile(&mut samples, 99);
    println!("{label}: p50={p50}ns p95={p95}ns p99={p99}ns n={}", samples.len());
}
fn measure_rope(size: usize, position: &str, iterations: usize) -> Vec<u128> {
    let mut rope = RopeText::new("a".repeat(size));
    let offset = match position { "inicio" => 0, "centro" => size / 2, _ => size };
    let mut replacement = "b";
    let mut samples = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let started = Instant::now();
        rope.replace_range(offset..offset, replacement).expect("inserción rope");
        rope.replace_range(offset..offset + replacement.len(), "").expect("borrado rope");
        samples.push(started.elapsed().as_nanos());
        replacement = if replacement == "b" { "a" } else { "b" };
        black_box(rope.len());
    }
    samples
}
fn measure_string(size: usize, position: &str, iterations: usize) -> Vec<u128> {
    let mut text = "a".repeat(size);
    let offset = match position { "inicio" => 0, "centro" => size / 2, _ => size };
    let mut replacement = "b";
    let mut samples = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let started = Instant::now();
        text.insert_str(offset, replacement);
        text.replace_range(offset..offset + replacement.len(), "");
        samples.push(started.elapsed().as_nanos());
        replacement = if replacement == "b" { "a" } else { "b" };
        black_box(text.len());
    }
    samples
}
fn paragraph_document(target_size: usize) -> String {
    let paragraph = "El escritor desarrolla una escena con personajes y detalles.\n\n";
    let mut text = String::with_capacity(target_size);
    while text.len() < target_size { text.push_str(paragraph); }
    text
}
fn measure_rope_paragraph(text: &str, iterations: usize) -> Vec<u128> {
    let rope = RopeText::new(text);
    let offset = text.len() / 2;
    let mut samples = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let started = Instant::now();
        black_box(affected_paragraph_range_rope(&rope, offset, offset).expect("rango Rope"));
        samples.push(started.elapsed().as_nanos());
    }
    samples
}
fn measure_string_paragraph(text: &str, iterations: usize) -> Vec<u128> {
    let offset = text.len() / 2;
    let mut samples = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let started = Instant::now();
        black_box(affected_paragraph_range(text, offset, offset).expect("rango String"));
        samples.push(started.elapsed().as_nanos());
    }
    samples
}
fn measure_rope_newline_search(text: &str, iterations: usize, backward: bool) -> Vec<u128> {
    let rope = RopeText::new(text);
    let mut samples = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let started = Instant::now();
        let result = if backward {
            black_box(&rope).find_byte_backward(b'\n', rope.len())
        } else {
            black_box(&rope).find_byte_forward(b'\n', 0)
        };
        black_box(result);
        samples.push(started.elapsed().as_nanos());
    }
    samples
}
fn measure_string_newline_search(text: &str, iterations: usize, backward: bool) -> Vec<u128> {
    let bytes = text.as_bytes();
    let mut samples = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let started = Instant::now();
        let result = if backward {
            black_box(bytes).iter().rposition(|byte| *byte == b'\n')
        } else {
            black_box(bytes).iter().position(|byte| *byte == b'\n')
        };
        black_box(result);
        samples.push(started.elapsed().as_nanos());
    }
    samples
}

fn measure_worker_durable_edits(size: usize, iterations: usize) -> Vec<u128> {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
    let root = std::env::temp_dir().join(format!("motor-literario-worker-bench-{}-{nonce}-{size}", std::process::id()));
    fs::create_dir_all(&root).expect("create temp directory");
    let pages = root.join("store.pages");
    let wal = root.join("store.mlpj");
    let project_id = format!("worker-bench-{size}");
    let engine = PersistentLiveEngine::open(&project_id, &pages, &wal).expect("open MLDB");
    let mut worker = LiveEngineWorker::open(engine, 64).expect("start worker");
    let initial_text = "a".repeat(size);
    worker.open_document("chapter", initial_text, 0, 0).expect("open document");
    let offset = size / 2;
    let mut samples = Vec::with_capacity(iterations);
    for index in 0..iterations {
        let replacement = if index % 2 == 0 { "b" } else { "a" };
        let change = PendingChange::new("chapter", index as u64 + 1, index as u64, offset, offset + 1, replacement);
        let started = Instant::now();
        let ticket = worker.try_submit_change(change).expect("admit change");
        black_box(ticket.wait().expect("durable acknowledgement"));
        samples.push(started.elapsed().as_nanos());
    }
    let metrics = worker.metrics();
    assert_eq!(metrics.durable_commits, iterations as u64);
    assert_eq!(metrics.end_to_end_sample_count, iterations.min(256));
    println!(
        "worker_end_to_end samples={} submit_to_durable_p50={}us p95={}us p99={}us max={}us",
        metrics.end_to_end_sample_count,
        metrics.p50_submit_to_durable_commit_micros,
        metrics.p95_submit_to_durable_commit_micros,
        metrics.p99_submit_to_durable_commit_micros,
        metrics.max_submit_to_durable_commit_micros,
    );
    worker.shutdown().expect("shutdown worker");
    fs::remove_dir_all(root).expect("remove temp directory");
    samples
}

fn measure_worker_burst_under_analysis(size: usize, iterations: usize) -> Vec<u128> {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
    let root = std::env::temp_dir().join(format!("motor-literario-worker-burst-{}-{nonce}-{size}", std::process::id()));
    fs::create_dir_all(&root).expect("create temp directory");
    let pages = root.join("store.pages");
    let wal = root.join("store.mlpj");
    let project_id = format!("worker-burst-{size}");
    let engine = PersistentLiveEngine::open(&project_id, &pages, &wal).expect("open MLDB");
    let mut worker = LiveEngineWorker::open(engine, 64).expect("start worker");
    let initial_text = paragraph_document(size);
    let offset = initial_text.len() / 2;
    worker.open_document("chapter", initial_text, 0, 0).expect("open document");
    let mut changes: VecDeque<(Instant, motor_literario_core::ChangeTicket)> = VecDeque::new();
    let mut extractions = VecDeque::new();
    let mut extraction_samples = Vec::with_capacity(iterations);
    let mut extraction_rejections = 0usize;
    let mut extraction_stale = 0usize;
    let mut samples = Vec::with_capacity(iterations);
    for index in 0..iterations {
        match worker.request_affected_paragraph("chapter", index as u64, offset, offset) {
            Ok(ticket) => extractions.push_back((Instant::now(), ticket)),
            Err(motor_literario_core::TicketError::QueueFull) => extraction_rejections += 1,
            Err(error) => panic!("analysis request failed: {error:?}"),
        }
        let replacement = if index % 2 == 0 { "b" } else { "a" };
        let change = PendingChange::new("chapter", index as u64 + 1, index as u64, offset, offset + 1, replacement);
        let started = Instant::now();
        match worker.try_submit_change(change) {
            Ok(ticket) => changes.push_back((started, ticket)),
            Err(motor_literario_core::SubmitError::QueueFull(change)) => {
                let (queued_at, oldest) = changes.pop_front().expect("a full queue has a pending ticket");
                black_box(oldest.wait().expect("durable acknowledgement"));
                samples.push(queued_at.elapsed().as_nanos());
                let ticket = worker.try_submit_change(change).expect("admit after freeing queue capacity");
                changes.push_back((started, ticket));
            }
            Err(motor_literario_core::SubmitError::WorkerStopped(_)) => panic!("worker stopped"),
        }
    }
    while let Some((queued_at, ticket)) = changes.pop_front() {
        black_box(ticket.wait().expect("durable acknowledgement"));
        samples.push(queued_at.elapsed().as_nanos());
    }
    while let Some((submitted_at, ticket)) = extractions.pop_front() {
        match ticket.wait() {
            Ok(snapshot) => {
                black_box((snapshot.revision, snapshot.last_sequence, snapshot.text.len()));
                extraction_samples.push(submitted_at.elapsed().as_nanos());
            }
            Err(motor_literario_core::TicketError::Engine(
                motor_literario_core::EngineError::AnalysisRevisionConflict { .. },
            )) => {
                extraction_stale += 1;
            }
            Err(error) => panic!("unexpected paragraph extraction failure: {error:?}"),
        }
    }
    let metrics = worker.metrics();
    assert_eq!(metrics.durable_commits, iterations as u64);
    assert_eq!(metrics.failed_changes, 0);
    assert_eq!(metrics.end_to_end_sample_count, iterations.min(256));
    assert_eq!(extraction_samples.len() + extraction_stale + extraction_rejections, iterations);
    assert_eq!(metrics.paragraph_queue_rejections, extraction_rejections as u64);
    assert_eq!(metrics.pending_changes, 0);
    assert_eq!(metrics.pending_paragraph_extractions, 0);
    println!(
        "worker_queue_metrics max_pending={} write_rejections={} analysis_rejections={} queue_wait_p95={}us durable_commit_p95={}us",
        metrics.max_pending_changes,
        metrics.queue_full_rejections,
        metrics.paragraph_queue_rejections,
        metrics.p95_queue_wait_micros,
        metrics.p95_commit_micros,
    );
    println!(
        "worker_end_to_end samples={} submit_to_durable_p50={}us p95={}us p99={}us max={}us",
        metrics.end_to_end_sample_count,
        metrics.p50_submit_to_durable_commit_micros,
        metrics.p95_submit_to_durable_commit_micros,
        metrics.p99_submit_to_durable_commit_micros,
        metrics.max_submit_to_durable_commit_micros,
    );
    let extraction_p50 = percentile(&mut extraction_samples, 50);
    let extraction_p95 = percentile(&mut extraction_samples, 95);
    let extraction_p99 = percentile(&mut extraction_samples, 99);
    println!(
        "worker_analysis_latency completed={} stale_revision={} rejected={} end_to_end_p50={}ns p95={}ns p99={}ns queue_wait_p95={}us extraction_p95={}us",
        extraction_samples.len(),
        extraction_stale,
        extraction_rejections,
        extraction_p50,
        extraction_p95,
        extraction_p99,
        metrics.p95_extraction_queue_wait_micros,
        metrics.p95_extraction_micros,
    );
    worker.shutdown().expect("shutdown worker");
    fs::remove_dir_all(root).expect("remove temp directory");
    samples
}


fn json_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    for character in value.chars() {
        match character {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            character if character.is_control() => {
                use std::fmt::Write;
                write!(&mut escaped, "\\u{:04x}", character as u32).expect("write JSON escape");
            }
            character => escaped.push(character),
        }
    }
    escaped
}

fn rpc_request(server: &mut JsonRpcServer, id: &str, method: &str, params: &str) -> String {
    let request = format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":\"{}\",\"method\":\"{}\",\"params\":{{{}}}}}",
        json_escape(id), json_escape(method), params,
    );
    let response = server.handle_line(&request);
    assert!(!response.contains("\"error\""), "JSON-RPC {method} failed: {response}");
    response
}

fn json_number_field(response: &str, field: &str) -> u64 {
    let needle = format!("\"{field}\"");
    let key_end = response.find(&needle)
        .unwrap_or_else(|| panic!("missing {field} in JSON-RPC response: {response}"))
        + needle.len();
    let after_colon = response[key_end..].trim_start();
    let value = after_colon.strip_prefix(':')
        .unwrap_or_else(|| panic!("missing colon after {field} in JSON-RPC response: {response}"))
        .trim_start();
    let digits = value.chars().take_while(|character| character.is_ascii_digit()).collect::<String>();
    digits.parse::<u64>().unwrap_or_else(|_| panic!("invalid numeric field {field}: {response}"))
}

fn poll_rpc_until_complete(
    server: &mut JsonRpcServer,
    id: &str,
    method: &str,
    params: &str,
) -> String {
    let deadline = Instant::now() + std::time::Duration::from_secs(60);
    loop {
        let response = rpc_request(server, id, method, params);
        if !response.contains("\"status\":\"pending\"") {
            return response;
        }
        assert!(Instant::now() < deadline, "timeout polling {method}");
        std::thread::yield_now();
    }
}

fn measure_jsonrpc_live_analysis(size: usize, iterations: usize) -> Vec<u128> {
    assert!(iterations > 0 && iterations <= 10_000, "JSON-RPC benchmark iterations must be between 1 and 10000");
    // El parser JSON-RPC limita cada cadena a 12 MiB y cada mensaje a 16 MiB.
    // El texto inicial se envía en una sola solicitud open_document, por lo
    // que los tamaños superiores a 10 MiB no son representables por este transporte.
    assert!(size <= 10 * 1024 * 1024, "JSON-RPC open_document is limited by the protocol message size");
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
    let root = std::env::temp_dir().join(format!(
        "motor-literario-jsonrpc-bench-{}-{nonce}-{size}", std::process::id()
    ));
    fs::create_dir_all(&root).expect("create JSON-RPC benchmark directory");
    let pages = root.join("engine.pages");
    let journal = root.join("engine.mlpj");
    let knowledge_pages = root.join("knowledge.pages");
    let knowledge_journal = root.join("knowledge.mlpj");
    let mut server = JsonRpcServer::new();
    let initialize = format!(
        "\"project_id\":\"jsonrpc-bench-{size}\",\"pages_path\":\"{}\",\"journal_path\":\"{}\",\"queue_capacity\":64,\"knowledge_pages_path\":\"{}\",\"knowledge_journal_path\":\"{}\"",
        json_escape(&pages.to_string_lossy()),
        json_escape(&journal.to_string_lossy()),
        json_escape(&knowledge_pages.to_string_lossy()),
        json_escape(&knowledge_journal.to_string_lossy()),
    );
    rpc_request(&mut server, "initialize", "initialize", &initialize);

    let paragraph = "La narración conserva personajes, acciones y detalles verificables mientras el escritor modifica el manuscrito. Marcador 00000000. La escena mantiene continuidad, ritmo y coherencia entre sus acontecimientos.\n\n";
    let paragraph_count = (size / paragraph.len()).max(1);
    let initial_text = paragraph.repeat(paragraph_count);
    let target_paragraph = paragraph_count / 2;
    let marker_offset = target_paragraph * paragraph.len()
        + paragraph.find("00000000").expect("marker in paragraph");
    let actual_size = initial_text.len();
    let open = format!(
        "\"document_id\":\"chapter\",\"text\":\"{}\",\"revision\":0,\"sequence\":0",
        json_escape(&initial_text),
    );
    rpc_request(&mut server, "open", "open_document", &open);

    let mut samples = Vec::with_capacity(iterations);
    let mut extraction_samples = Vec::with_capacity(iterations);
    let mut linguistic_samples = Vec::with_capacity(iterations);
    let mut persistence_samples = Vec::with_capacity(iterations);
    let mut cache_hits = 0usize;
    for index in 0..iterations {
        // Ocho dígitos mantienen estable el tamaño del documento y producen
        // fragmentos distintos para medir análisis real, no solo aciertos de caché.
        let replacement = format!("{:08}", index + 1);
        let change_id = format!("change-{index}");
        let change_params = format!(
            "\"document_id\":\"chapter\",\"sequence\":{},\"base_revision\":{},\"start_byte\":{},\"end_byte\":{},\"replacement\":\"{}\"",
            index + 1, index, marker_offset, marker_offset + 8, replacement,
        );
        let started = Instant::now();
        rpc_request(&mut server, &change_id, "editor_change", &change_params);
        let commit_params = format!("\"ticket_id\":\"{}\"", change_id);
        let commit = poll_rpc_until_complete(
            &mut server, &format!("poll-change-{index}"), "poll_commit", &commit_params,
        );
        assert!(commit.contains("\"status\":\"applied\""), "unexpected commit result: {commit}");

        let analysis_ticket = format!("analysis-ticket-{index}");
        let analysis_id = format!("analysis-{index}");
        let analysis_params = format!(
            "\"document_id\":\"chapter\",\"expected_revision\":{},\"selection_start_byte\":{},\"selection_end_byte\":{}",
            index + 1, marker_offset, marker_offset + 8,
        );
        rpc_request(
            &mut server, &analysis_ticket, "request_analyze_affected_paragraph", &analysis_params,
        );
        let poll_params = format!(
            "\"ticket_id\":\"{}\",\"analysis_id\":\"{}\"", analysis_ticket, analysis_id,
        );
        let analysis = poll_rpc_until_complete(
            &mut server, &format!("poll-analysis-{index}"),
            "poll_analyze_affected_paragraph", &poll_params,
        );
        assert!(analysis.contains("\"status\":\"ready\""), "analysis did not complete: {analysis}");
        assert!(analysis.contains("\"persisted\":true"), "analysis was not persisted: {analysis}");
        if analysis.contains("\"analysis_cache_hit\":true") {
            cache_hits += 1;
        }
        extraction_samples.push(json_number_field(&analysis, "extraction_micros") as u128 * 1_000);
        linguistic_samples.push(json_number_field(&analysis, "analysis_micros") as u128 * 1_000);
        persistence_samples.push(json_number_field(&analysis, "persistence_micros") as u128 * 1_000);
        samples.push(started.elapsed().as_nanos());
    }

    let status = rpc_request(&mut server, "status", "status", "");
    assert_eq!(json_number_field(&status, "durable_commits"), iterations as u64);
    assert_eq!(json_number_field(&status, "failed_changes"), 0);
    assert_eq!(json_number_field(&status, "pending_changes"), 0);
    assert_eq!(json_number_field(&status, "pending_tickets"), 0);
    assert_eq!(json_number_field(&status, "pending_analysis_jobs"), 0);
    assert_eq!(cache_hits, 0, "unique marker text should force fresh linguistic analysis");
    println!(
        "jsonrpc_live_analysis size={} iterations={} cache_hits={} persisted={} status={}",
        actual_size, iterations, cache_hits, iterations, status,
    );
    report("JSON-RPC paragraph extraction", extraction_samples);
    report("JSON-RPC linguistic analysis", linguistic_samples);
    report("JSON-RPC analysis persistence", persistence_samples);
    rpc_request(&mut server, "shutdown", "shutdown", "");
    drop(server);
    fs::remove_dir_all(root).expect("remove JSON-RPC benchmark directory");
    samples
}

fn main() {
    let iterations = std::env::var("ROPE_BENCH_ITERATIONS")
        .ok().and_then(|s| s.parse::<usize>().ok()).filter(|count| *count > 0).unwrap_or(25usize);
    for size in [100 * 1024, 1024 * 1024, 10 * 1024 * 1024, 50 * 1024 * 1024] {
        let document = paragraph_document(size);
        println!("paragraph_lookup size={} iterations={iterations}", document.len());
        report("Rope paragraph", measure_rope_paragraph(&document, iterations));
        report("String paragraph", measure_string_paragraph(&document, iterations));
        let no_newline = "x".repeat(size);
        println!("newline_search no_match size={size} iterations={iterations}");
        report("Rope forward", measure_rope_newline_search(&no_newline, iterations, false));
        report("String forward", measure_string_newline_search(&no_newline, iterations, false));
        report("Rope backward", measure_rope_newline_search(&no_newline, iterations, true));
        report("String backward", measure_string_newline_search(&no_newline, iterations, true));

        let late_newline = format!("{}\nfin", "x".repeat(size));
        println!("newline_search late_match size={size} iterations={iterations}");
        report("Rope forward", measure_rope_newline_search(&late_newline, iterations, false));
        report("String forward", measure_string_newline_search(&late_newline, iterations, false));
        report("Rope backward", measure_rope_newline_search(&late_newline, iterations, true));
        report("String backward", measure_string_newline_search(&late_newline, iterations, true));
        for position in ["inicio", "centro", "final"] {
            println!("size={size} position={position} iterations={iterations}");
            report("RopeText", measure_rope(size, position, iterations));
            report("String", measure_string(size, position, iterations));
        }
    }
    let worker_iterations = std::env::var("ROPE_WORKER_BENCH_ITERATIONS")
        .ok().and_then(|s| s.parse::<usize>().ok()).filter(|count| *count > 0).unwrap_or(10usize);
    println!("worker_durable_roundtrip iterations={worker_iterations}");
    for size in [100 * 1024, 1024 * 1024, 10 * 1024 * 1024, 50 * 1024 * 1024] {
        println!("worker_durable size={size} bytes iterations={worker_iterations}");
        report("Worker submit+durable ack", measure_worker_durable_edits(size, worker_iterations));
    }
    let burst_iterations = std::env::var("ROPE_WORKER_BURST_ITERATIONS")
        .ok().and_then(|s| s.parse::<usize>().ok()).filter(|count| *count > 0).unwrap_or(1024usize);
    println!("worker_sustained_with_analysis iterations={burst_iterations} queue_capacity=64");
    for size in [100 * 1024, 1024 * 1024, 10 * 1024 * 1024, 50 * 1024 * 1024] {
        println!("worker_burst size={size} bytes iterations={burst_iterations}");
        report("Worker burst under analysis load", measure_worker_burst_under_analysis(size, burst_iterations));
    }
    let jsonrpc_iterations = std::env::var("ROPE_JSONRPC_BENCH_ITERATIONS")
        .ok().and_then(|value| value.parse::<usize>().ok())
        .filter(|count| *count > 0).unwrap_or(5usize);
    println!("jsonrpc_live_analysis iterations={jsonrpc_iterations}");
    // JSON-RPC recibe el snapshot inicial como una sola cadena; 50 MiB
    // excede los límites documentados del parser (12 MiB por cadena).
    for size in [100 * 1024, 1024 * 1024, 10 * 1024 * 1024] {
        report(
            "JSON-RPC edit-to-persisted-analysis",
            measure_jsonrpc_live_analysis(size, jsonrpc_iterations),
        );
    }
}
