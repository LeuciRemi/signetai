/// Phase 0.0: sqlite-vec Static Integration Spike
///
/// Validates that we can:
/// 1. Compile sqlite-vec C amalgamation into rusqlite's bundled SQLite
/// 2. Register via sqlite3_auto_extension
/// 3. Create vec0 virtual tables and run vector operations
/// 4. Open an existing TS-created database and query vectors
use std::env;
use std::path::Path;

fn register_vec_extension() {
    unsafe {
        #[allow(clippy::missing_transmute_annotations)]
        let func = std::mem::transmute(sqlite_vec::sqlite3_vec_init as *const ());
        rusqlite::ffi::sqlite3_auto_extension(Some(func));
    }
}

fn test_basic_vector_ops() -> Result<(), Box<dyn std::error::Error>> {
    println!("--- Test 1: Basic vector operations ---");

    let conn = rusqlite::Connection::open_in_memory()?;

    // Verify sqlite-vec is loaded
    let version: String = conn.query_row("SELECT vec_version()", [], |r| r.get(0))?;
    println!("  vec_version(): {version}");

    // Create a vec0 virtual table (same schema as signet's vec_embeddings)
    conn.execute_batch(
        "CREATE VIRTUAL TABLE vec_test USING vec0(
            id TEXT PRIMARY KEY,
            embedding FLOAT[4] distance_metric=cosine
        );",
    )?;
    println!("  Created vec0 table with FLOAT[4] cosine distance");

    // Insert test vectors
    let vectors: &[(&str, &[f32; 4])] = &[
        ("mem_1", &[1.0, 0.0, 0.0, 0.0]),
        ("mem_2", &[0.0, 1.0, 0.0, 0.0]),
        ("mem_3", &[0.707, 0.707, 0.0, 0.0]),
        ("mem_4", &[0.9, 0.1, 0.0, 0.0]),
    ];

    for (id, vec) in vectors {
        let blob: Vec<u8> = vec.iter().flat_map(|f| f.to_le_bytes()).collect();
        conn.execute(
            "INSERT INTO vec_test (id, embedding) VALUES (?1, ?2)",
            rusqlite::params![id, blob],
        )?;
    }
    println!("  Inserted {} vectors", vectors.len());

    // KNN query: find closest to [1, 0, 0, 0]
    let query_vec: [f32; 4] = [1.0, 0.0, 0.0, 0.0];
    let query_blob: Vec<u8> = query_vec.iter().flat_map(|f| f.to_le_bytes()).collect();

    let mut stmt = conn.prepare(
        "SELECT id, distance
         FROM vec_test
         WHERE embedding MATCH ?1
         AND k = 3
         ORDER BY distance",
    )?;

    let results: Vec<(String, f64)> = stmt
        .query_map([&query_blob[..]], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    println!("  KNN results (closest to [1,0,0,0]):");
    for (id, dist) in &results {
        println!("    {id}: distance={dist:.4}");
    }

    // Validate ordering: mem_1 should be closest (distance ~0), then mem_4, then mem_3
    assert_eq!(results[0].0, "mem_1", "closest should be mem_1");
    assert!(results[0].1 < 0.01, "mem_1 distance should be ~0");
    assert_eq!(results[1].0, "mem_4", "second closest should be mem_4");
    assert_eq!(results[2].0, "mem_3", "third closest should be mem_3");
    println!("  Ordering validation PASSED");

    // Test vec_distance_cosine directly
    let v1: Vec<u8> = [1.0f32, 0.0, 0.0, 0.0]
        .iter()
        .flat_map(|f| f.to_le_bytes())
        .collect();
    let v2: Vec<u8> = [0.0f32, 1.0, 0.0, 0.0]
        .iter()
        .flat_map(|f| f.to_le_bytes())
        .collect();

    let dist: f64 = conn.query_row(
        "SELECT vec_distance_cosine(?1, ?2)",
        rusqlite::params![v1, v2],
        |r| r.get(0),
    )?;
    println!("  vec_distance_cosine([1,0,0,0], [0,1,0,0]) = {dist:.4}");
    assert!(
        (dist - 1.0).abs() < 0.01,
        "orthogonal vectors should have cosine distance ~1.0"
    );
    println!("  Distance function validation PASSED");

    Ok(())
}

fn test_realistic_dimensions() -> Result<(), Box<dyn std::error::Error>> {
    println!("\n--- Test 2: Realistic dimension vectors (768-dim) ---");

    let conn = rusqlite::Connection::open_in_memory()?;

    conn.execute_batch(
        "CREATE VIRTUAL TABLE vec_768 USING vec0(
            id TEXT PRIMARY KEY,
            embedding FLOAT[768] distance_metric=cosine
        );",
    )?;

    // Generate pseudo-random 768-dim vectors
    let rng = |seed: u64| -> Vec<f32> {
        let mut v = Vec::with_capacity(768);
        let mut x = seed;
        for _ in 0..768 {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1);
            v.push((x as f32) / (u64::MAX as f32));
        }
        // Normalize
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        for x in &mut v {
            *x /= norm;
        }
        v
    };

    let count = 100;
    for i in 0..count {
        let vec = rng(i as u64 + 42);
        let blob: Vec<u8> = vec.iter().flat_map(|f| f.to_le_bytes()).collect();
        conn.execute(
            "INSERT INTO vec_768 (id, embedding) VALUES (?1, ?2)",
            rusqlite::params![format!("mem_{i}"), blob],
        )?;
    }
    println!("  Inserted {count} 768-dim vectors");

    // KNN search
    let query = rng(42); // Should match mem_0 exactly
    let qblob: Vec<u8> = query.iter().flat_map(|f| f.to_le_bytes()).collect();

    let start = std::time::Instant::now();
    let mut stmt = conn.prepare(
        "SELECT id, distance FROM vec_768 WHERE embedding MATCH ?1 AND k = 5 ORDER BY distance",
    )?;
    let results: Vec<(String, f64)> = stmt
        .query_map([&qblob[..]], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let elapsed = start.elapsed();

    println!("  KNN search (k=5) took {:?}", elapsed);
    for (id, dist) in &results {
        println!("    {id}: distance={dist:.6}");
    }
    assert_eq!(results[0].0, "mem_0", "exact match should be first");
    assert!(results[0].1 < 1e-6, "exact match distance should be ~0");
    println!("  768-dim validation PASSED");

    Ok(())
}

fn test_existing_db(path: &str) -> Result<(), Box<dyn std::error::Error>> {
    println!("\n--- Test 3: Open existing TS-created database ---");
    println!("  Path: {path}");

    if !Path::new(path).exists() {
        println!("  SKIPPED: database file not found");
        return Ok(());
    }

    let conn = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;

    // Check schema
    let tables: Vec<String> = {
        let mut stmt =
            conn.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")?;
        stmt.query_map([], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    println!("  Tables: {}", tables.join(", "));

    // Check if vec_embeddings exists
    let has_vec = tables.iter().any(|t| t == "vec_embeddings");
    if !has_vec {
        println!("  vec_embeddings table not found — vector search may be disabled");
        println!("  PASSED (DB opens and queries successfully)");
        return Ok(());
    }

    // Count vectors
    let vec_count: i64 = conn.query_row("SELECT count(*) FROM vec_embeddings", [], |r| r.get(0))?;
    println!("  vec_embeddings rows: {vec_count}");

    if vec_count > 0 {
        // Run a vector query against the existing data
        let sample: Vec<u8> =
            conn.query_row("SELECT embedding FROM vec_embeddings LIMIT 1", [], |r| {
                r.get(0)
            })?;
        println!("  Sample embedding size: {} bytes", sample.len());

        let dims = sample.len() / 4; // f32 = 4 bytes
        println!("  Detected dimensions: {dims}");

        // KNN with the sample vector against itself
        let mut stmt = conn.prepare(
            "SELECT id, distance FROM vec_embeddings WHERE embedding MATCH ?1 AND k = 3 ORDER BY distance",
        )?;
        let results: Vec<(String, f64)> = stmt
            .query_map([&sample[..]], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        println!("  KNN results from existing DB:");
        for (id, dist) in &results {
            println!("    {id}: distance={dist:.6}");
        }
        assert!(results[0].1 < 1e-6, "self-match should have distance ~0");
        println!("  Existing DB vector query PASSED");
    }

    // Also verify we can read memories table
    let mem_count: i64 = conn.query_row("SELECT count(*) FROM memories", [], |r| r.get(0))?;
    println!("  memories rows: {mem_count}");

    // Verify schema_migrations
    let schema_ver: i64 =
        conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| {
            r.get(0)
        })?;
    println!("  schema version: {schema_ver}");

    println!("  Existing DB validation PASSED");
    Ok(())
}

fn test_wal_mode() -> Result<(), Box<dyn std::error::Error>> {
    println!("\n--- Test 4: WAL mode + pragmas (daemon config) ---");

    let tmp = std::env::temp_dir().join("vec_spike_wal_test.db");
    let conn = rusqlite::Connection::open(&tmp)?;

    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA busy_timeout = 5000;
         PRAGMA synchronous = NORMAL;
         PRAGMA temp_store = MEMORY;",
    )?;

    let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
    assert_eq!(mode, "wal", "journal_mode should be WAL");

    conn.execute_batch(
        "CREATE VIRTUAL TABLE vec_wal USING vec0(
            id TEXT PRIMARY KEY,
            embedding FLOAT[768] distance_metric=cosine
        );",
    )?;

    println!("  WAL mode + vec0 table creation PASSED");

    // Clean up
    drop(conn);
    let _ = std::fs::remove_file(&tmp);
    let _ = std::fs::remove_file(format!("{}-wal", tmp.display()));
    let _ = std::fs::remove_file(format!("{}-shm", tmp.display()));

    Ok(())
}

fn main() {
    println!("=== sqlite-vec Static Integration Spike ===\n");

    // Register sqlite-vec as auto-extension BEFORE opening any connections
    register_vec_extension();

    if let Err(e) = test_basic_vector_ops() {
        eprintln!("FAILED: basic vector ops: {e}");
        std::process::exit(1);
    }

    if let Err(e) = test_realistic_dimensions() {
        eprintln!("FAILED: realistic dimensions: {e}");
        std::process::exit(1);
    }

    // Test against existing TS-created DB if available
    let db_path = env::var("SIGNET_TEST_DB").unwrap_or_else(|_| {
        let home = env::var("HOME")
            .or_else(|_| env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".into());
        format!("{home}/.agents/memory/memories.db")
    });
    if let Err(e) = test_existing_db(&db_path) {
        eprintln!("FAILED: existing DB: {e}");
        std::process::exit(1);
    }

    if let Err(e) = test_wal_mode() {
        eprintln!("FAILED: WAL mode: {e}");
        std::process::exit(1);
    }

    println!("\n=== ALL SPIKE TESTS PASSED ===");
}
