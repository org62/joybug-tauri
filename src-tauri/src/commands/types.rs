/// Data structures used only by command return types (not shared with session processing)

#[derive(serde::Serialize)]
pub struct ModuleData {
    pub name: String,
    pub base_address: String,
    pub size: u64,
    pub path: String,
}

#[derive(serde::Serialize)]
pub struct ThreadData {
    pub id: u32,
    pub status: String,
    pub start_address: String,
}

#[derive(serde::Serialize)]
pub struct ModuleSymbolStatusData {
    pub module_path: String,
    pub base_address: String,
    /// "loaded" | "loading" | "failed" | "not_requested"
    pub status: String,
    pub symbol_count: Option<usize>,
    pub error: Option<String>,
    pub pdb_path: Option<String>,
}

#[derive(serde::Serialize)]
pub struct PdbMismatchData {
    pub pe_guid: String,
    pub pe_age: u32,
    pub pdb_guid: String,
    pub pdb_age: u32,
}

#[derive(serde::Serialize)]
pub struct PdbLoadResultData {
    pub loaded: bool,
    pub symbol_count: Option<usize>,
    pub mismatch: Option<PdbMismatchData>,
}
