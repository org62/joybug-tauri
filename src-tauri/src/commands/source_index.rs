//! The line index behind the Source view's windowed reads, and its disk cache.
//!
//! The view never loads a whole file: it asks for a range of lines, and the
//! index says where in the file to start reading. Building it means reading
//! the whole file once — which for a multi-gigabyte generated source is the
//! difference between a view that opens at once and one that opens after ten
//! seconds — so three things keep that off the user's clock:
//!
//! * **The index is block-based**, not line-based: it records how many line
//!   breaks precede each fixed-size block of the file. A block's count depends
//!   on nothing outside the block, so the blocks are counted **in parallel**
//!   and summed afterwards — one pass, on every core.
//! * **It is kept on disk** (`<data dir>/source-index/`), keyed by path and
//!   validated by size and modification time, so a file is indexed once, not
//!   once per run.
//! * **The checksum** that proves the file is the one the module was built
//!   from needs a second, sequential pass (a hash cannot be split). It is not
//!   part of opening: the caller verifies in the background and reports later,
//!   and the result is stored with the index.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use sha2::Digest;

/// Bytes per index block. Reaching a line means scanning at most one block
/// from its start; the index of a 5 GB file is ~43 K entries (~340 KB).
const BLOCK_BYTES: u64 = 128 * 1024;
/// Blocks a worker reads at a time.
const SEGMENT_BLOCKS: u64 = 32;
/// More readers than this stop helping: the disk, not the CPU, is the limit.
const MAX_THREADS: usize = 16;
/// Streaming buffer of the checksum pass.
const HASH_BUF: usize = 1 << 20;
/// Indexes kept on disk; the least recently written go first.
const MAX_STORED: usize = 50;

const MAGIC: &[u8; 4] = b"JBSI";
const FORMAT_VERSION: u32 = 1;

/// How many line breaks precede each block of a file.
#[derive(Debug, PartialEq)]
pub(crate) struct LineIndex {
    pub len: u64,
    pub mtime_ns: u128,
    /// Lines in the file (a maximal run of non-newline bytes, `\n`- or EOF-terminated).
    pub line_count: u64,
    block: u64,
    /// `newlines_before[k]` = number of `\n` in `[0, k * block)`.
    newlines_before: Vec<u64>,
}

impl LineIndex {
    /// Index `path`, counting its blocks on as many threads as help.
    pub fn build(path: &Path, mtime_ns: u128) -> std::io::Result<Self> {
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).min(MAX_THREADS);
        Self::build_with(path, mtime_ns, BLOCK_BYTES, threads)
    }

    fn build_with(path: &Path, mtime_ns: u128, block: u64, threads: usize) -> std::io::Result<Self> {
        let len = fs::metadata(path)?.len();
        let blocks = len.div_ceil(block);
        let segments = blocks.div_ceil(SEGMENT_BLOCKS);
        let segment_bytes = (SEGMENT_BLOCKS * block) as usize;

        // Workers take segments off a shared counter and report the newline
        // count of every block in each.
        let next = AtomicU64::new(0);
        let counted: Mutex<Vec<(u64, Vec<u64>)>> = Mutex::new(Vec::new());
        let failed: Mutex<Option<std::io::Error>> = Mutex::new(None);
        let work = || {
            let run = || -> std::io::Result<()> {
                let mut file = File::open(path)?;
                let mut buf = vec![0u8; segment_bytes];
                loop {
                    let segment = next.fetch_add(1, Ordering::Relaxed);
                    if segment >= segments {
                        return Ok(());
                    }
                    file.seek(SeekFrom::Start(segment * segment_bytes as u64))?;
                    let mut filled = 0;
                    while filled < buf.len() {
                        match file.read(&mut buf[filled..])? {
                            0 => break,
                            n => filled += n,
                        }
                    }
                    let counts = buf[..filled]
                        .chunks(block as usize)
                        .map(|b| b.iter().filter(|&&byte| byte == b'\n').count() as u64)
                        .collect();
                    counted.lock().unwrap().push((segment, counts));
                }
            };
            if let Err(e) = run() {
                failed.lock().unwrap().get_or_insert(e);
            }
        };
        std::thread::scope(|scope| {
            for _ in 0..threads.clamp(1, segments.max(1) as usize) {
                scope.spawn(work);
            }
        });
        if let Some(e) = failed.into_inner().unwrap() {
            return Err(e);
        }

        let mut counted = counted.into_inner().unwrap();
        counted.sort_unstable_by_key(|(segment, _)| *segment);
        let mut newlines_before = Vec::with_capacity(blocks as usize);
        let mut newlines = 0u64;
        for count in counted.into_iter().flat_map(|(_, counts)| counts) {
            newlines_before.push(newlines);
            newlines += count;
        }
        // A file that shrank under the scan: the blocks that are gone hold nothing.
        newlines_before.resize(blocks as usize, newlines);

        let ends_with_newline = len > 0 && {
            let mut file = File::open(path)?;
            let mut last = [0u8; 1];
            file.seek(SeekFrom::Start(len - 1))?;
            file.read_exact(&mut last)?;
            last[0] == b'\n'
        };
        // A trailing newline ends the last line; it does not start another.
        let line_count = if len == 0 { 0 } else { newlines + u64::from(!ends_with_newline) };
        Ok(Self { len, mtime_ns, line_count, block, newlines_before })
    }

    /// Where to start reading to reach `line` (1-based): a byte offset, and how
    /// many line breaks to read past from there to stand at the line's start.
    pub fn seek_for_line(&self, line: u64) -> (u64, u64) {
        let breaks = line.saturating_sub(1);
        if breaks == 0 || self.newlines_before.is_empty() {
            return (0, 0);
        }
        // The last block with fewer line breaks before it than we must pass:
        // the break that ends the previous line is in it (or it spans it).
        let block = self.newlines_before.partition_point(|&before| before < breaks) - 1;
        (block as u64 * self.block, breaks - self.newlines_before[block])
    }
}

/// A content checksum as a module's debug info records it: the algorithm's
/// name and the lowercase hex digest.
type Checksum = (String, String);

/// A checksum algorithm we can compute, as a module's debug info names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChecksumKind {
    Md5,
    Sha1,
    Sha256,
}

impl ChecksumKind {
    pub fn parse(kind: &str) -> Option<Self> {
        match kind {
            "md5" => Some(Self::Md5),
            "sha1" => Some(Self::Sha1),
            "sha256" => Some(Self::Sha256),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Md5 => "md5",
            Self::Sha1 => "sha1",
            Self::Sha256 => "sha256",
        }
    }
}

/// An indexed file: the index, and the file's checksum once someone computed it.
pub(crate) struct IndexedFile {
    pub index: LineIndex,
    checksum: Mutex<Option<Checksum>>,
    verifying: AtomicBool,
}

impl IndexedFile {
    pub fn new(index: LineIndex, checksum: Option<Checksum>) -> Self {
        Self { index, checksum: Mutex::new(checksum), verifying: AtomicBool::new(false) }
    }

    /// The file's checksum of this kind, if it has been computed.
    pub fn checksum(&self, kind: ChecksumKind) -> Option<String> {
        self.checksum.lock().unwrap().as_ref().filter(|(k, _)| k == kind.as_str()).map(|(_, hex)| hex.clone())
    }

    pub fn set_checksum(&self, kind: ChecksumKind, hex: &str) {
        *self.checksum.lock().unwrap() = Some((kind.as_str().to_string(), hex.to_string()));
    }

    /// Claim the (one) background verification of this file. `false`: another
    /// is already on its way and will report.
    pub fn begin_verifying(&self) -> bool {
        !self.verifying.swap(true, Ordering::AcqRel)
    }

    pub fn end_verifying(&self) {
        self.verifying.store(false, Ordering::Release);
    }
}

/// The file's checksum of the given kind, as lowercase hex. One sequential
/// pass over the whole file.
pub(crate) fn file_checksum(path: &Path, kind: ChecksumKind) -> std::io::Result<String> {
    fn digest<D: Digest>(path: &Path) -> std::io::Result<String> {
        let mut file = File::open(path)?;
        let mut hasher = D::new();
        let mut buf = vec![0u8; HASH_BUF];
        loop {
            match file.read(&mut buf)? {
                0 => break,
                n => hasher.update(&buf[..n]),
            }
        }
        Ok(crate::data_dir::hex_lower(&hasher.finalize()))
    }
    match kind {
        ChecksumKind::Md5 => digest::<md5::Md5>(path),
        ChecksumKind::Sha1 => digest::<sha1::Sha1>(path),
        ChecksumKind::Sha256 => digest::<sha2::Sha256>(path),
    }
}

// ---------------------------------------------------------------------------
// Disk cache
// ---------------------------------------------------------------------------

fn store_dir() -> PathBuf {
    crate::data_dir::joybug_data_dir().join("source-index")
}

/// The cache file of a source path: named by a hash of the path, so any path
/// is a valid file name and none can leave the folder.
fn stored_path(dir: &Path, resolved_path: &str) -> PathBuf {
    let digest = sha2::Sha256::digest(resolved_path.to_lowercase().as_bytes());
    dir.join(format!("{}.idx", crate::data_dir::hex_lower(&digest[..16])))
}

fn encode(file: &IndexedFile) -> Vec<u8> {
    let index = &file.index;
    let checksum = file.checksum.lock().unwrap().clone();
    let (kind, hex) = checksum.unwrap_or_default();
    let mut out = Vec::with_capacity(64 + kind.len() + hex.len() + index.newlines_before.len() * 8);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    out.extend_from_slice(&index.len.to_le_bytes());
    out.extend_from_slice(&index.mtime_ns.to_le_bytes());
    out.extend_from_slice(&index.block.to_le_bytes());
    out.extend_from_slice(&index.line_count.to_le_bytes());
    for text in [&kind, &hex] {
        out.push(text.len() as u8);
        out.extend_from_slice(text.as_bytes());
    }
    out.extend_from_slice(&(index.newlines_before.len() as u64).to_le_bytes());
    for count in &index.newlines_before {
        out.extend_from_slice(&count.to_le_bytes());
    }
    out
}

/// Decode a cache file, accepting it only for a file of exactly this size and
/// modification time. Anything unexpected is a miss, never an error: the
/// index is rebuilt.
fn decode(bytes: &[u8], len: u64, mtime_ns: u128) -> Option<IndexedFile> {
    struct Cursor<'a>(&'a [u8]);
    impl<'a> Cursor<'a> {
        fn take(&mut self, n: usize) -> Option<&'a [u8]> {
            let (head, rest) = self.0.split_at_checked(n)?;
            self.0 = rest;
            Some(head)
        }
        fn u64(&mut self) -> Option<u64> {
            Some(u64::from_le_bytes(self.take(8)?.try_into().ok()?))
        }
        fn text(&mut self) -> Option<String> {
            let n = *self.take(1)?.first()? as usize;
            String::from_utf8(self.take(n)?.to_vec()).ok()
        }
    }
    let mut cursor = Cursor(bytes);
    if cursor.take(4)? != MAGIC || cursor.take(4)? != FORMAT_VERSION.to_le_bytes() {
        return None;
    }
    let stored_len = cursor.u64()?;
    let stored_mtime = u128::from_le_bytes(cursor.take(16)?.try_into().ok()?);
    let block = cursor.u64()?;
    let line_count = cursor.u64()?;
    let kind = cursor.text()?;
    let hex = cursor.text()?;
    let blocks = cursor.u64()?;
    if stored_len != len || stored_mtime != mtime_ns || block != BLOCK_BYTES || blocks != len.div_ceil(block) {
        return None;
    }
    if cursor.0.len() as u64 != blocks.checked_mul(8)? {
        return None;
    }
    let newlines_before = cursor.0.chunks_exact(8).map(|c| u64::from_le_bytes(c.try_into().unwrap())).collect();
    let checksum = (!kind.is_empty()).then_some((kind, hex));
    Some(IndexedFile::new(LineIndex { len, mtime_ns, line_count, block, newlines_before }, checksum))
}

/// The stored index of `resolved_path`, if the file is still the one indexed.
pub(crate) fn load(resolved_path: &str, len: u64, mtime_ns: u128) -> Option<IndexedFile> {
    load_from(&store_dir(), resolved_path, len, mtime_ns)
}

fn load_from(dir: &Path, resolved_path: &str, len: u64, mtime_ns: u128) -> Option<IndexedFile> {
    decode(&fs::read(stored_path(dir, resolved_path)).ok()?, len, mtime_ns)
}

/// Store (or replace) the index of `resolved_path`. Best effort: a cache that
/// cannot be written costs a re-index next time, nothing else.
pub(crate) fn save(resolved_path: &str, file: &IndexedFile) {
    if let Err(e) = save_to(&store_dir(), resolved_path, file) {
        tracing::warn!("Source index for {} not cached: {}", resolved_path, e);
    }
}

fn save_to(dir: &Path, resolved_path: &str, file: &IndexedFile) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let path = stored_path(dir, resolved_path);
    // Written whole, then renamed into place: a reader never sees half a file.
    let partial = path.with_extension("idx.partial");
    fs::write(&partial, encode(file))?;
    fs::rename(&partial, &path)?;
    crate::data_dir::prune_oldest(dir, "idx", MAX_STORED);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::TempDir;
    use std::io::{BufRead, BufReader, Write};

    /// Read line `line` through the index, the way `read_source_window` does.
    fn line_via_index(path: &Path, index: &LineIndex, line: u64) -> String {
        let (offset, skip) = index.seek_for_line(line);
        let mut reader = BufReader::new(File::open(path).unwrap());
        reader.seek(SeekFrom::Start(offset)).unwrap();
        let mut scratch = Vec::new();
        for _ in 0..skip {
            scratch.clear();
            reader.read_until(b'\n', &mut scratch).unwrap();
        }
        scratch.clear();
        reader.read_until(b'\n', &mut scratch).unwrap();
        String::from_utf8(scratch).unwrap().trim_end_matches(['\n', '\r']).to_string()
    }

    #[test]
    fn every_line_is_reachable_whatever_the_block_size_and_thread_count() {
        let dir = TempDir::new("joybug-source-index-test");
        // Lines of uneven length (some empty, some longer than a block), CRLF
        // and LF mixed, so breaks land on every position relative to a block.
        let lines: Vec<String> = (0..700)
            .map(|i| match i % 7 {
                0 => String::new(),
                3 => "x".repeat(40 + i % 23),
                _ => format!("line {i}"),
            })
            .collect();
        let mut content = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            content.extend_from_slice(line.as_bytes());
            content.extend_from_slice(if i % 5 == 0 { b"\r\n" } else { b"\n" });
        }
        let path = dir.file("mixed.c", &content);

        let reference = LineIndex::build_with(&path, 0, 8, 1).unwrap();
        assert_eq!(reference.line_count, 700);
        for (block, threads) in [(1, 1), (7, 3), (8, 4), (16, 16), (4096, 2), (1 << 20, 8)] {
            let index = LineIndex::build_with(&path, 0, block, threads).unwrap();
            assert_eq!(index.line_count, 700, "block {block}, {threads} threads");
            for (i, expected) in lines.iter().enumerate() {
                assert_eq!(&line_via_index(&path, &index, i as u64 + 1), expected, "line {} (block {block})", i + 1);
            }
        }
        // The same index whatever the thread count.
        assert_eq!(LineIndex::build_with(&path, 0, 8, 16).unwrap(), reference);
    }

    #[test]
    fn line_counts_follow_the_trailing_newline() {
        let dir = TempDir::new("joybug-source-index-test");
        for (content, lines) in [("", 0), ("a", 1), ("a\n", 1), ("a\nb", 2), ("a\nb\n", 2), ("\n", 1), ("\n\n", 2)] {
            let path = dir.file("f.c", content.as_bytes());
            let index = LineIndex::build_with(&path, 0, 4, 2).unwrap();
            assert_eq!(index.line_count, lines, "{content:?}");
        }
    }

    #[test]
    fn the_stored_index_round_trips_and_is_tied_to_the_file() {
        let dir = TempDir::new("joybug-source-index-test");
        let content: String = (0..5000).map(|i| format!("row {i}\n")).collect();
        let path = dir.file("big.c", content.as_bytes());
        let len = content.len() as u64;
        let indexed = IndexedFile::new(LineIndex::build(&path, 42).unwrap(), None);
        let store = dir.0.join("store");

        assert!(load_from(&store, "C:/src/Big.c", len, 42).is_none(), "nothing stored yet");
        save_to(&store, "C:/src/Big.c", &indexed).unwrap();

        let loaded = load_from(&store, "c:/SRC/big.c", len, 42).expect("paths differ only in case");
        assert_eq!(loaded.index, indexed.index);
        assert_eq!(loaded.checksum(ChecksumKind::Md5), None);

        // A different size or time is a different file.
        assert!(load_from(&store, "C:/src/Big.c", len + 1, 42).is_none());
        assert!(load_from(&store, "C:/src/Big.c", len, 43).is_none());
        // And so is another path.
        assert!(load_from(&store, "C:/src/Other.c", len, 42).is_none());

        // The checksum is stored with it, per kind.
        indexed.set_checksum(ChecksumKind::Sha256, "abcd");
        save_to(&store, "C:/src/Big.c", &indexed).unwrap();
        let loaded = load_from(&store, "C:/src/Big.c", len, 42).unwrap();
        assert_eq!(loaded.checksum(ChecksumKind::Sha256).as_deref(), Some("abcd"));
        assert_eq!(loaded.checksum(ChecksumKind::Md5), None);
    }

    #[test]
    fn a_damaged_cache_file_is_a_miss() {
        let dir = TempDir::new("joybug-source-index-test");
        let path = dir.file("f.c", b"one\ntwo\n");
        let indexed = IndexedFile::new(LineIndex::build(&path, 7).unwrap(), Some(("md5".into(), "00".into())));
        let bytes = encode(&indexed);
        assert!(decode(&bytes, 8, 7).is_some());
        for cut in 0..bytes.len() {
            assert!(decode(&bytes[..cut], 8, 7).is_none(), "truncated at {cut}");
        }
        let mut wrong_magic = bytes.clone();
        wrong_magic[0] ^= 0xff;
        assert!(decode(&wrong_magic, 8, 7).is_none());
        let mut extra = bytes.clone();
        extra.push(0);
        assert!(decode(&extra, 8, 7).is_none());
    }

    #[test]
    fn checksums_match_known_digests() {
        let dir = TempDir::new("joybug-source-index-test");
        let path = dir.file("abc.txt", b"abc");
        assert_eq!(file_checksum(&path, ChecksumKind::Md5).unwrap(), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(file_checksum(&path, ChecksumKind::Sha1).unwrap(), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(file_checksum(&path, ChecksumKind::Sha256).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(ChecksumKind::parse("sha256"), Some(ChecksumKind::Sha256));
        assert_eq!(ChecksumKind::parse("crc32"), None);
    }

    /// How long a large file takes to index, and to hash. Heavy (writes
    /// `JOYBUG_BENCH_GB` gigabytes, default 5, to the temp dir) and only
    /// meaningful optimized:
    ///   cargo test --release --lib source_index -- --ignored --nocapture
    #[test]
    #[ignore = "heavy: writes a multi-GB file"]
    fn index_benchmark() {
        let gb: f64 = std::env::var("JOYBUG_BENCH_GB").ok().and_then(|v| v.parse().ok()).unwrap_or(5.0);
        let dir = TempDir::new("joybug-source-index-test");
        let path = dir.0.join("huge.c");
        let chunk: Vec<u8> = (0..20_000).flat_map(|i| format!("    value_{i} = compute(value_{}, {i});
", i / 2).into_bytes()).collect();
        let mut written = 0u64;
        {
            let mut file = std::io::BufWriter::new(File::create(&path).unwrap());
            while (written as f64) < gb * 1e9 {
                file.write_all(&chunk).unwrap();
                written += chunk.len() as u64;
            }
        }
        println!("file: {:.2} GB", written as f64 / 1e9);

        for threads in [1, MAX_THREADS] {
            let started = std::time::Instant::now();
            let index = LineIndex::build_with(&path, 0, BLOCK_BYTES, threads).unwrap();
            println!("index, {threads:>2} thread(s): {:>7.0} ms ({} lines, {} blocks)", started.elapsed().as_secs_f64() * 1e3, index.line_count, index.newlines_before.len());
        }
        let indexed = IndexedFile::new(LineIndex::build(&path, 0).unwrap(), None);
        let store = dir.0.join("store");
        let started = std::time::Instant::now();
        save_to(&store, "huge.c", &indexed).unwrap();
        let loaded = load_from(&store, "huge.c", written, 0).unwrap();
        println!("store + load:        {:>7.1} ms ({} KB on disk)", started.elapsed().as_secs_f64() * 1e3, fs::metadata(stored_path(&store, "huge.c")).unwrap().len() / 1024);
        assert_eq!(loaded.index, indexed.index);
        for kind in [ChecksumKind::Md5, ChecksumKind::Sha256] {
            let started = std::time::Instant::now();
            file_checksum(&path, kind).unwrap();
            println!("checksum {:<7}:    {:>7.0} ms", kind.as_str(), started.elapsed().as_secs_f64() * 1e3);
        }
    }

    #[test]
    fn only_one_verification_is_claimed_at_a_time() {
        let dir = TempDir::new("joybug-source-index-test");
        let path = dir.file("f.c", b"x\n");
        let indexed = IndexedFile::new(LineIndex::build(&path, 0).unwrap(), None);
        assert!(indexed.begin_verifying());
        assert!(!indexed.begin_verifying());
        indexed.end_verifying();
        assert!(indexed.begin_verifying());
    }
}
