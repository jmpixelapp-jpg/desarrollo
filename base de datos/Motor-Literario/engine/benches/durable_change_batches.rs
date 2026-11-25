//! Microbenchmark of durable MLPJ transaction amortization for editor deltas.
//!
//! Models each delta as one event record plus an update to the document head.
//! It intentionally performs no sleeps: each measured batch is committed as
//! soon as it is assembled, matching a worker that batches only queued work.

use std::fs;
use std::hint::black_box;
use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use mldb_storage::project_store::{ProjectOperation, ProjectStore};

const BATCH_SIZES: &[usize] = &[1, 2, 4, 8, 16];
const BATCHES_PER_SIZE: usize = 200;

fn temporary_root() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before UNIX epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "motor-literario-durable-bench-{}-{nonce}",
        std::process::id()
    ))
}

fn main() {
    let root = temporary_root();
    fs::create_dir_all(&root).expect("create benchmark directory");

    println!("Durable editor-delta transaction benchmark");
    println!("{} batches per size; one event Put and one head Put per delta", BATCHES_PER_SIZE);

    for &batch_size in BATCH_SIZES {
        let scenario = root.join(format!("batch-{batch_size}"));
        fs::create_dir_all(&scenario).expect("create scenario directory");
        let pages = scenario.join("store.pages");
        let wal = scenario.join("store.mlpj");
        let mut store = ProjectStore::open(&pages, &wal).expect("open benchmark store");

        let started = Instant::now();
        let mut committed_deltas = 0usize;
        for batch_index in 0..BATCHES_PER_SIZE {
            let first_sequence = batch_index * batch_size;
            let mut operations = Vec::with_capacity(batch_size * 2);
            for offset in 0..batch_size {
                let sequence = first_sequence + offset + 1;
                operations.push(ProjectOperation::Put {
                    project_id: "benchmark-book".to_owned(),
                    table: "live_events_".to_owned(),
                    record_id: format!("chapter:{sequence:012}:0000"),
                    value: black_box(vec![(sequence % 251) as u8; 96]),
                });
                operations.push(ProjectOperation::Put {
                    project_id: "benchmark-book".to_owned(),
                    table: "live_document_heads".to_owned(),
                    record_id: "chapter".to_owned(),
                    value: black_box(sequence.to_le_bytes().to_vec()),
                });
            }
            black_box(store.apply_batch(operations).expect("commit batch"));
            committed_deltas += batch_size;
        }
        let elapsed = started.elapsed();
        let nanos_per_delta = elapsed.as_nanos() / committed_deltas as u128;
        println!(
            "batch={batch_size:>2} deltas/transaction | transactions={BATCHES_PER_SIZE:>3} | deltas={committed_deltas:>4} | total={elapsed:?} | ns/delta={nanos_per_delta}"
        );
        drop(store);
    }

    fs::remove_dir_all(&root).expect("remove benchmark directory");
}
