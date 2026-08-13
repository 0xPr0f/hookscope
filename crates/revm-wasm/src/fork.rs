#[cfg(feature = "libafl-fuzz")]
use super::{
    coverage_index, outcome_fingerprint, register_libafl_types, ExplorationWitness,
    FUZZ_COVERAGE_MAP_SIZE, MAX_FUZZ_INPUT_BYTES,
};
use super::{state_diffs, EvidenceInspector, ExecutionProof};
#[cfg(feature = "libafl-fuzz")]
use libafl::{
    corpus::InMemoryCorpus,
    events::SimpleEventManager,
    executors::{ExitKind, InProcessExecutor},
    feedbacks::{CrashFeedback, MaxMapFeedback},
    inputs::{BytesInput, HasTargetBytes},
    monitors::SimpleMonitor,
    mutators::{havoc_mutations, HavocScheduledMutator},
    observers::StdMapObserver,
    schedulers::QueueScheduler,
    stages::StdMutationalStage,
    state::{HasExecutions, HasMaxSize, StdState},
    Evaluator, Fuzzer, StdFuzzer,
};
#[cfg(feature = "libafl-fuzz")]
use libafl_bolts::{nonzero, rands::StdRand, tuples::tuple_list, AsSlice};
use revm::{
    context::{BlockEnv, CfgEnv, Context, TxEnv},
    context_interface::result::EVMError,
    database_interface::DBErrorMarker,
    inspector::InspectEvm,
    primitives::{hardfork::SpecId, Address, Bytes, StorageKey, StorageValue, TxKind, B256, U256},
    state::{AccountInfo, Bytecode},
    Database, MainBuilder, MainContext,
};
use serde::{Deserialize, Serialize};
#[cfg(feature = "libafl-fuzz")]
use std::collections::{BTreeSet, HashSet};
use std::{
    cell::RefCell,
    collections::HashMap,
    error::Error,
    fmt::{Display, Formatter},
    rc::Rc,
    str::FromStr,
};
use wasm_bindgen::prelude::*;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotAccount {
    address: String,
    exists: bool,
    balance: String,
    nonce: u64,
    code: String,
    #[serde(default)]
    storage: HashMap<String, String>,
    #[serde(default)]
    storage_complete: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotBlockHash {
    number: u64,
    hash: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum HydrationUpdate {
    Account {
        account: SnapshotAccount,
    },
    Storage {
        address: String,
        slot: String,
        value: String,
    },
    BlockHash {
        block_number: u64,
        hash: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForkSnapshot {
    #[serde(default)]
    accounts: Vec<SnapshotAccount>,
    #[serde(default)]
    block_hashes: Vec<SnapshotBlockHash>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForkTransaction {
    caller: String,
    to: String,
    calldata: String,
    value: String,
    gas_limit: u64,
    gas_price: String,
    nonce: u64,
    chain_id: u64,
    max_priority_fee_per_gas: Option<String>,
    #[serde(default = "default_trace_limit")]
    trace_limit: usize,
}

fn default_trace_limit() -> usize {
    8_192
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForkBlock {
    number: u64,
    beneficiary: String,
    timestamp: String,
    gas_limit: u64,
    base_fee: u64,
    difficulty: String,
    prevrandao: Option<String>,
}

#[derive(Debug, Clone)]
enum HydrationError {
    MissingAccount(Address),
    MissingCode(B256),
    MissingStorage(Address, StorageKey),
    MissingBlockHash(u64),
}

impl Display for HydrationError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingAccount(address) => write!(formatter, "missing account {address:?}"),
            Self::MissingCode(hash) => write!(formatter, "missing code {hash:?}"),
            Self::MissingStorage(address, slot) => {
                write!(formatter, "missing storage {address:?}:{slot:#x}")
            }
            Self::MissingBlockHash(number) => write!(formatter, "missing block hash {number}"),
        }
    }
}

impl Error for HydrationError {}
impl DBErrorMarker for HydrationError {}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum HydrationRequest {
    Account { address: String },
    Code { code_hash: String },
    Storage { address: String, slot: String },
    BlockHash { block_number: u64 },
}

impl From<HydrationError> for HydrationRequest {
    fn from(error: HydrationError) -> Self {
        match error {
            HydrationError::MissingAccount(address) => Self::Account {
                address: format!("{address:?}"),
            },
            HydrationError::MissingCode(code_hash) => Self::Code {
                code_hash: format!("{code_hash:?}"),
            },
            HydrationError::MissingStorage(address, slot) => Self::Storage {
                address: format!("{address:?}"),
                slot: format!("0x{slot:064x}"),
            },
            HydrationError::MissingBlockHash(block_number) => Self::BlockHash { block_number },
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
enum ForkStep {
    Complete { proof: ExecutionProof },
    Missing { request: HydrationRequest },
    Failure { message: String },
}

#[derive(Debug, Default)]
struct HydratedDatabase {
    accounts: HashMap<Address, Option<AccountInfo>>,
    code: HashMap<B256, Bytecode>,
    storage: HashMap<(Address, StorageKey), StorageValue>,
    block_hashes: HashMap<u64, B256>,
    complete_storage: std::collections::HashSet<Address>,
}

fn parse_value<T: FromStr>(value: &str, label: &str) -> Result<T, String>
where
    T::Err: Display,
{
    value
        .parse::<T>()
        .map_err(|error| format!("invalid {label}: {error}"))
}

fn parse_bytes(value: &str, label: &str) -> Result<Bytes, String> {
    let bytes = hex::decode(value.strip_prefix("0x").unwrap_or(value))
        .map_err(|error| format!("invalid {label}: {error}"))?;
    Ok(Bytes::from(bytes))
}

fn parse_u128(value: &str, label: &str) -> Result<u128, String> {
    if let Some(hex) = value.strip_prefix("0x") {
        u128::from_str_radix(hex, 16).map_err(|error| format!("invalid {label}: {error}"))
    } else {
        value
            .parse::<u128>()
            .map_err(|error| format!("invalid {label}: {error}"))
    }
}

impl HydratedDatabase {
    fn insert_account(&mut self, account: SnapshotAccount) -> Result<(), String> {
        let address = parse_value::<Address>(&account.address, "account address")?;
        if !account.exists {
            self.accounts.insert(address, None);
            if account.storage_complete {
                self.complete_storage.insert(address);
            }
            return Ok(());
        }
        let bytecode = Bytecode::new_raw(parse_bytes(&account.code, "account code")?);
        let info = AccountInfo::default()
            .with_balance(parse_value::<U256>(&account.balance, "account balance")?)
            .with_nonce(account.nonce)
            .with_code(bytecode.clone());
        self.code.insert(info.code_hash, bytecode);
        self.accounts.insert(address, Some(info));
        for (slot, value) in account.storage {
            self.storage.insert(
                (address, parse_value::<StorageKey>(&slot, "storage slot")?),
                parse_value::<StorageValue>(&value, "storage value")?,
            );
        }
        if account.storage_complete {
            self.complete_storage.insert(address);
        }
        Ok(())
    }

    fn from_snapshot(snapshot: ForkSnapshot) -> Result<Self, String> {
        let mut database = Self::default();
        for account in snapshot.accounts {
            database.insert_account(account)?;
        }
        for block in snapshot.block_hashes {
            database.block_hashes.insert(
                block.number,
                parse_value::<B256>(&block.hash, "block hash")?,
            );
        }
        Ok(database)
    }

    fn hydrate(&mut self, update: HydrationUpdate) -> Result<(), String> {
        match update {
            HydrationUpdate::Account { account } => self.insert_account(account),
            HydrationUpdate::Storage {
                address,
                slot,
                value,
            } => {
                let address = parse_value::<Address>(&address, "storage address")?;
                if !self.accounts.contains_key(&address) {
                    return Err(format!("cannot hydrate storage before account {address:?}"));
                }
                self.storage.insert(
                    (address, parse_value::<StorageKey>(&slot, "storage slot")?),
                    parse_value::<StorageValue>(&value, "storage value")?,
                );
                Ok(())
            }
            HydrationUpdate::BlockHash { block_number, hash } => {
                self.block_hashes
                    .insert(block_number, parse_value::<B256>(&hash, "block hash")?);
                Ok(())
            }
        }
    }

    fn commit_state(&mut self, state: &revm::state::EvmState) {
        for (address, account) in state {
            if !account.is_touched() {
                continue;
            }
            if account.is_selfdestructed() {
                self.accounts.insert(*address, None);
                self.storage
                    .retain(|(stored_address, _), _| stored_address != address);
                continue;
            }
            let info = account.info.clone();
            if let Some(code) = info.code.clone() {
                self.code.insert(info.code_hash, code);
            }
            self.accounts.insert(*address, Some(info));
            for (slot, value) in &account.storage {
                if value.is_changed() {
                    self.storage
                        .insert((*address, *slot), value.present_value());
                }
            }
        }
    }
}

#[derive(Clone, Debug)]
struct SharedDatabase(Rc<RefCell<HydratedDatabase>>);

impl Database for SharedDatabase {
    type Error = HydrationError;

    fn basic(&mut self, address: Address) -> Result<Option<AccountInfo>, Self::Error> {
        self.0
            .borrow()
            .accounts
            .get(&address)
            .cloned()
            .ok_or(HydrationError::MissingAccount(address))
    }

    fn code_by_hash(&mut self, code_hash: B256) -> Result<Bytecode, Self::Error> {
        self.0
            .borrow()
            .code
            .get(&code_hash)
            .cloned()
            .ok_or(HydrationError::MissingCode(code_hash))
    }

    fn storage(
        &mut self,
        address: Address,
        index: StorageKey,
    ) -> Result<StorageValue, Self::Error> {
        let database = self.0.borrow();
        if let Some(value) = database.storage.get(&(address, index)).copied() {
            Ok(value)
        } else if database.complete_storage.contains(&address) {
            Ok(StorageValue::ZERO)
        } else {
            Err(HydrationError::MissingStorage(address, index))
        }
    }

    fn block_hash(&mut self, number: u64) -> Result<B256, Self::Error> {
        self.0
            .borrow()
            .block_hashes
            .get(&number)
            .copied()
            .ok_or(HydrationError::MissingBlockHash(number))
    }
}

thread_local! {
    static FORK_SESSIONS: RefCell<HashMap<String, SharedDatabase>> = RefCell::new(HashMap::new());
}

fn build_block(input: ForkBlock) -> Result<BlockEnv, String> {
    Ok(BlockEnv {
        number: U256::from(input.number),
        beneficiary: parse_value(&input.beneficiary, "block beneficiary")?,
        timestamp: parse_value(&input.timestamp, "block timestamp")?,
        gas_limit: input.gas_limit,
        basefee: input.base_fee,
        difficulty: parse_value(&input.difficulty, "block difficulty")?,
        prevrandao: input
            .prevrandao
            .map(|value| parse_value(&value, "block prevrandao"))
            .transpose()?,
        ..BlockEnv::default()
    })
}

fn build_transaction(input: ForkTransaction) -> Result<TxEnv, String> {
    let mut builder = TxEnv::builder()
        .caller(parse_value(&input.caller, "transaction caller")?)
        .kind(TxKind::Call(parse_value(&input.to, "transaction target")?))
        .data(parse_bytes(&input.calldata, "transaction calldata")?)
        .value(parse_value(&input.value, "transaction value")?)
        .gas_limit(input.gas_limit)
        .max_fee_per_gas(parse_u128(&input.gas_price, "transaction gas price")?)
        .nonce(input.nonce)
        .chain_id(Some(input.chain_id));
    if let Some(priority_fee) = input.max_priority_fee_per_gas {
        builder =
            builder.gas_priority_fee(Some(parse_u128(&priority_fee, "transaction priority fee")?));
    }
    builder
        .build()
        .map_err(|error| format!("invalid fork transaction: {error}"))
}

fn run_database(
    database: SharedDatabase,
    transaction: ForkTransaction,
    block: ForkBlock,
    commit: bool,
) -> ForkStep {
    let trace_limit = transaction.trace_limit;
    let chain_id = transaction.chain_id;
    let transaction = match build_transaction(transaction) {
        Ok(transaction) => transaction,
        Err(message) => return ForkStep::Failure { message },
    };
    let block = match build_block(block) {
        Ok(block) => block,
        Err(message) => return ForkStep::Failure { message },
    };
    let context = Context::mainnet()
        .with_db(database.clone())
        .with_block(block)
        .with_cfg(CfgEnv::<SpecId>::default().with_chain_id(chain_id));
    let mut inspector = EvidenceInspector::with_step_limit(trace_limit);
    let result_and_state = {
        let mut evm = context.build_mainnet_with_inspector(&mut inspector);
        match evm.inspect_tx(transaction) {
            Ok(result) => result,
            Err(EVMError::Database(error)) => {
                return ForkStep::Missing {
                    request: error.into(),
                }
            }
            Err(error) => {
                return ForkStep::Failure {
                    message: error.to_string(),
                }
            }
        }
    };
    let result = result_and_state.result;
    let storage_diffs = state_diffs(&result_and_state.state);
    if commit {
        database
            .0
            .borrow_mut()
            .commit_state(&result_and_state.state);
    }
    ForkStep::Complete {
        proof: ExecutionProof {
            engine: "revm/36.0.0",
            success: result.is_success(),
            gas_used: result.gas_used(),
            output: result
                .output()
                .map(|bytes| format!("0x{}", hex::encode(bytes)))
                .unwrap_or_else(|| "0x".to_owned()),
            steps: inspector.steps,
            storage_operations: inspector.storage_operations,
            calls: inspector.calls,
            storage_diffs,
            log_count: inspector.log_count,
            selfdestructs: inspector.selfdestructs,
            truncated: inspector.truncated,
        },
    }
}

fn run_snapshot(
    snapshot: ForkSnapshot,
    transaction: ForkTransaction,
    block: ForkBlock,
) -> ForkStep {
    match HydratedDatabase::from_snapshot(snapshot) {
        Ok(database) => run_database(
            SharedDatabase(Rc::new(RefCell::new(database))),
            transaction,
            block,
            false,
        ),
        Err(message) => ForkStep::Failure { message },
    }
}

#[cfg(feature = "libafl-fuzz")]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForkExplorationSummary {
    engine: &'static str,
    strategy: &'static str,
    executions: usize,
    coverage_edges: usize,
    unique_outcomes: usize,
    witnesses: Vec<ExplorationWitness>,
    skipped_executions: usize,
    missing_requests: Vec<HydrationRequest>,
    missing_candidates: Vec<ForkMissingCandidate>,
}

#[cfg(feature = "libafl-fuzz")]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForkMissingCandidate {
    calldata: String,
    request: HydrationRequest,
}

#[cfg(feature = "libafl-fuzz")]
fn address_identity(value: &str) -> usize {
    let hash = value
        .as_bytes()
        .iter()
        .fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100_0000_01b3)
        });
    (hash ^ (hash >> 32)) as usize
}

#[cfg(feature = "libafl-fuzz")]
fn fuzz_database(
    database: SharedDatabase,
    transaction: ForkTransaction,
    block: ForkBlock,
    max_executions: usize,
    seed: u64,
    mut mutable_indices: Vec<usize>,
    seed_corpus: &[Vec<u8>],
) -> Result<ForkExplorationSummary, String> {
    register_libafl_types();
    let execution_limit = max_executions.clamp(1, 30_000);
    let base_calldata = parse_bytes(&transaction.calldata, "transaction calldata")?.to_vec();
    mutable_indices.sort_unstable();
    mutable_indices.dedup();
    if mutable_indices
        .iter()
        .any(|index| *index >= base_calldata.len())
    {
        return Err("fork mutation index exceeds the transaction calldata length".to_owned());
    }
    if mutable_indices.is_empty() {
        return Err("fork exploration requires at least one mutable calldata byte".to_owned());
    }
    if mutable_indices.len() > MAX_FUZZ_INPUT_BYTES {
        return Err(format!(
            "fork exploration exceeds the {MAX_FUZZ_INPUT_BYTES}-byte mutation ceiling"
        ));
    }

    let compact_seed = |calldata: &[u8]| {
        mutable_indices
            .iter()
            .map(|index| calldata[*index])
            .collect::<Vec<_>>()
    };
    let mut seeds = vec![compact_seed(&base_calldata)];
    for candidate in seed_corpus.iter().take(64) {
        if candidate.len() == base_calldata.len() {
            seeds.push(compact_seed(candidate));
        }
    }
    seeds.push(vec![0u8; mutable_indices.len()]);
    seeds.push(vec![0xffu8; mutable_indices.len()]);
    let mut unique_seeds = BTreeSet::new();
    seeds.retain(|value| unique_seeds.insert(value.clone()));

    let mut signals = vec![0u8; FUZZ_COVERAGE_MAP_SIZE];
    let signals_ptr = signals.as_mut_ptr();
    let mut covered_edges = HashSet::<(usize, usize)>::new();
    let mut outcomes = BTreeSet::<String>::new();
    let mut witnesses = Vec::<ExplorationWitness>::new();
    let mut missing_requests = Vec::<HydrationRequest>::new();
    let mut missing_candidates = Vec::<ForkMissingCandidate>::new();
    let mut missing_identities = HashSet::<String>::new();
    let mut skipped_executions = 0usize;

    let executions = {
        let mut harness = |input: &BytesInput| {
            unsafe { std::ptr::write_bytes(signals_ptr, 0, FUZZ_COVERAGE_MAP_SIZE) };
            let mutation = input.target_bytes();
            let mut calldata = base_calldata.clone();
            for (offset, index) in mutable_indices.iter().enumerate() {
                if let Some(value) = mutation.as_slice().get(offset) {
                    calldata[*index] = *value;
                }
            }
            let mut candidate = transaction.clone();
            candidate.calldata = format!("0x{}", hex::encode(&calldata));
            match run_database(database.clone(), candidate, block.clone(), false) {
                ForkStep::Complete { proof } => {
                    let mut previous = usize::MAX;
                    let mut new_edges = 0usize;
                    for step in &proof.steps {
                        let current = address_identity(&step.address) ^ step.pc;
                        let edge = (previous, current);
                        let index = coverage_index(previous, current);
                        unsafe {
                            let counter = signals_ptr.add(index);
                            *counter = (*counter).saturating_add(1);
                        }
                        if covered_edges.insert(edge) {
                            new_edges += 1;
                        }
                        previous = current;
                    }
                    let new_outcome = outcomes.insert(outcome_fingerprint(&proof));
                    if (new_edges > 0 || new_outcome) && witnesses.len() < 128 {
                        witnesses.push(ExplorationWitness {
                            calldata: format!("0x{}", hex::encode(calldata)),
                            success: proof.success,
                            gas_used: proof.gas_used,
                            new_edges,
                            output: proof.output.clone(),
                            storage_diffs: proof.storage_diffs,
                        });
                    }
                }
                ForkStep::Missing { request } => {
                    skipped_executions += 1;
                    let identity = format!("{request:?}");
                    if missing_candidates.len() < 64 {
                        missing_candidates.push(ForkMissingCandidate {
                            calldata: format!("0x{}", hex::encode(calldata)),
                            request: request.clone(),
                        });
                    }
                    if missing_requests.len() < 128 && missing_identities.insert(identity) {
                        missing_requests.push(request);
                    }
                }
                ForkStep::Failure { .. } => skipped_executions += 1,
            }
            ExitKind::Ok
        };

        #[allow(static_mut_refs)]
        let observer = unsafe {
            StdMapObserver::from_mut_ptr(
                "revm-fork-branch-edges",
                signals.as_mut_ptr(),
                signals.len(),
            )
        };
        let mut feedback = MaxMapFeedback::new(&observer);
        let mut objective = CrashFeedback::new();
        let mut state = StdState::new(
            StdRand::with_seed(seed),
            InMemoryCorpus::new(),
            InMemoryCorpus::new(),
            &mut feedback,
            &mut objective,
        )
        .map_err(|error| format!("LibAFL fork state failed: {error}"))?;
        state.set_max_size(mutable_indices.len());
        let monitor = SimpleMonitor::new(|_| {});
        let mut manager = SimpleEventManager::new(monitor);
        let scheduler = QueueScheduler::new();
        let mut fuzzer = StdFuzzer::new(scheduler, feedback, objective);
        let mut executor = InProcessExecutor::new(
            &mut harness,
            tuple_list!(observer),
            &mut fuzzer,
            &mut state,
            &mut manager,
        )
        .map_err(|error| format!("LibAFL fork executor failed: {error}"))?;

        for value in seeds.into_iter().take(execution_limit) {
            fuzzer
                .add_input(
                    &mut state,
                    &mut executor,
                    &mut manager,
                    BytesInput::new(value),
                )
                .map_err(|error| format!("LibAFL fork seed failed: {error}"))?;
        }
        let mutator = HavocScheduledMutator::new(havoc_mutations());
        let mut stages = tuple_list!(StdMutationalStage::with_max_iterations(
            mutator,
            nonzero!(1),
        ));
        let mut stalled_rounds = 0usize;
        while (*state.executions() as usize) < execution_limit {
            let before = *state.executions();
            fuzzer
                .fuzz_one(&mut stages, &mut executor, &mut state, &mut manager)
                .map_err(|error| format!("LibAFL fork step failed: {error}"))?;
            if *state.executions() == before {
                stalled_rounds += 1;
                if stalled_rounds > 1_024 {
                    return Err(
                        "LibAFL fork mutation loop stopped producing executions.".to_owned()
                    );
                }
            } else {
                stalled_rounds = 0;
            }
        }
        *state.executions() as usize
    };

    Ok(ForkExplorationSummary {
        engine: "revm/36.0.0 + libafl/0.15.4",
        strategy: "libafl-masked-router-fork/0.1.0",
        executions,
        coverage_edges: covered_edges.len(),
        unique_outcomes: outcomes.len(),
        witnesses,
        skipped_executions,
        missing_requests,
        missing_candidates,
    })
}

#[wasm_bindgen]
pub fn inspect_fork(
    snapshot: JsValue,
    transaction: JsValue,
    block: JsValue,
) -> Result<JsValue, JsValue> {
    let snapshot = serde_wasm_bindgen::from_value(snapshot)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let transaction = serde_wasm_bindgen::from_value(transaction)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let block = serde_wasm_bindgen::from_value(block)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    serde_wasm_bindgen::to_value(&run_snapshot(snapshot, transaction, block))
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen]
pub fn create_fork_session(session_id: String, snapshot: JsValue) -> Result<(), JsValue> {
    let snapshot: ForkSnapshot = serde_wasm_bindgen::from_value(snapshot)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let database =
        HydratedDatabase::from_snapshot(snapshot).map_err(|message| JsValue::from_str(&message))?;
    FORK_SESSIONS.with(|sessions| {
        sessions
            .borrow_mut()
            .insert(session_id, SharedDatabase(Rc::new(RefCell::new(database))));
    });
    Ok(())
}

#[wasm_bindgen]
pub fn hydrate_fork_session(session_id: String, update: JsValue) -> Result<(), JsValue> {
    let update = serde_wasm_bindgen::from_value(update)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    FORK_SESSIONS.with(|sessions| {
        let database = sessions.borrow().get(&session_id).cloned().ok_or_else(|| {
            JsValue::from_str(&format!("fork session {session_id} does not exist"))
        })?;
        let result = database
            .0
            .borrow_mut()
            .hydrate(update)
            .map_err(|message| JsValue::from_str(&message));
        result
    })
}

#[wasm_bindgen]
pub fn inspect_fork_session(
    session_id: String,
    transaction: JsValue,
    block: JsValue,
    commit: bool,
) -> Result<JsValue, JsValue> {
    let transaction = serde_wasm_bindgen::from_value(transaction)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let block = serde_wasm_bindgen::from_value(block)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let step = FORK_SESSIONS.with(|sessions| {
        sessions
            .borrow()
            .get(&session_id)
            .cloned()
            .map(|database| run_database(database, transaction, block, commit))
            .unwrap_or_else(|| ForkStep::Failure {
                message: format!("fork session {session_id} does not exist"),
            })
    });
    serde_wasm_bindgen::to_value(&step).map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen]
#[cfg(feature = "libafl-fuzz")]
pub fn fuzz_fork_session(
    session_id: String,
    transaction: JsValue,
    block: JsValue,
    max_executions: usize,
    seed: u64,
    mutable_indices: JsValue,
    seed_corpus: JsValue,
) -> Result<JsValue, JsValue> {
    let transaction = serde_wasm_bindgen::from_value(transaction)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let block = serde_wasm_bindgen::from_value(block)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let mutable_indices = serde_wasm_bindgen::from_value(mutable_indices)
        .map_err(|error| JsValue::from_str(&format!("invalid mutable indices: {error}")))?;
    let encoded_seeds: Vec<String> = serde_wasm_bindgen::from_value(seed_corpus)
        .map_err(|error| JsValue::from_str(&format!("invalid fork seed corpus: {error}")))?;
    let mut decoded_seeds = Vec::with_capacity(encoded_seeds.len().min(64));
    for value in encoded_seeds.into_iter().take(64) {
        decoded_seeds.push(
            hex::decode(value.strip_prefix("0x").unwrap_or(&value))
                .map_err(|error| JsValue::from_str(&format!("invalid fork seed: {error}")))?,
        );
    }
    let summary = FORK_SESSIONS
        .with(|sessions| {
            sessions
                .borrow()
                .get(&session_id)
                .cloned()
                .ok_or_else(|| format!("fork session {session_id} does not exist"))
                .and_then(|database| {
                    fuzz_database(
                        database,
                        transaction,
                        block,
                        max_executions,
                        seed,
                        mutable_indices,
                        &decoded_seeds,
                    )
                })
        })
        .map_err(|message| JsValue::from_str(&message))?;
    serde_wasm_bindgen::to_value(&summary).map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen]
pub fn dispose_fork_session(session_id: String) {
    FORK_SESSIONS.with(|sessions| {
        sessions.borrow_mut().remove(&session_id);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(address: &str, code: &str) -> SnapshotAccount {
        SnapshotAccount {
            address: address.to_owned(),
            exists: true,
            balance: "0xffffffffffffffff".to_owned(),
            nonce: 0,
            code: code.to_owned(),
            storage: HashMap::new(),
            storage_complete: false,
        }
    }

    fn transaction() -> ForkTransaction {
        ForkTransaction {
            caller: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".to_owned(),
            to: "0xffffffffffffffffffffffffffffffffffffffff".to_owned(),
            calldata: "0x".to_owned(),
            value: "0x0".to_owned(),
            gas_limit: 2_000_000,
            gas_price: "0x0".to_owned(),
            nonce: 0,
            chain_id: 1,
            max_priority_fee_per_gas: None,
            trace_limit: default_trace_limit(),
        }
    }

    fn block() -> ForkBlock {
        ForkBlock {
            number: 1,
            beneficiary: Address::ZERO.to_string(),
            timestamp: "0x1".to_owned(),
            gas_limit: 30_000_000,
            base_fee: 0,
            difficulty: "0x0".to_owned(),
            prevrandao: Some(B256::ZERO.to_string()),
        }
    }

    #[test]
    fn asks_for_accounts_before_execution() {
        let step = run_snapshot(
            ForkSnapshot {
                accounts: vec![],
                block_hashes: vec![],
            },
            transaction(),
            block(),
        );
        assert!(
            matches!(
                step,
                ForkStep::Missing {
                    request: HydrationRequest::Account { .. }
                }
            ),
            "{step:?}"
        );
    }

    #[test]
    fn asks_for_storage_then_completes_after_hydration() {
        let mut target = account("0xffffffffffffffffffffffffffffffffffffffff", "0x60005400");
        let caller = account("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "0x");
        let beneficiary = SnapshotAccount {
            address: Address::ZERO.to_string(),
            exists: false,
            balance: "0x0".to_owned(),
            nonce: 0,
            code: "0x".to_owned(),
            storage: HashMap::new(),
            storage_complete: false,
        };
        let first = run_snapshot(
            ForkSnapshot {
                accounts: vec![caller.clone(), target.clone(), beneficiary.clone()],
                block_hashes: vec![],
            },
            transaction(),
            block(),
        );
        assert!(
            matches!(
                first,
                ForkStep::Missing {
                    request: HydrationRequest::Storage { .. }
                }
            ),
            "{first:?}"
        );
        target.storage.insert("0x0".to_owned(), "0x2a".to_owned());
        let second = run_snapshot(
            ForkSnapshot {
                accounts: vec![caller, target, beneficiary],
                block_hashes: vec![],
            },
            transaction(),
            block(),
        );
        assert!(matches!(second, ForkStep::Complete { .. }));
    }

    #[cfg(feature = "libafl-fuzz")]
    #[test]
    fn masked_fork_exploration_preserves_the_router_envelope() {
        let mut target = account(
            "0xffffffffffffffffffffffffffffffffffffffff",
            "0x600035600014600f576001600055005b600260005500",
        );
        target.storage_complete = true;
        let caller = account("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "0x");
        let beneficiary = SnapshotAccount {
            address: Address::ZERO.to_string(),
            exists: false,
            balance: "0x0".to_owned(),
            nonce: 0,
            code: "0x".to_owned(),
            storage: HashMap::new(),
            storage_complete: true,
        };
        let database = HydratedDatabase::from_snapshot(ForkSnapshot {
            accounts: vec![caller, target, beneficiary],
            block_hashes: vec![],
        })
        .expect("fixture snapshot must parse");
        let mut transaction = transaction();
        transaction.calldata = format!("0x{}", "00".repeat(32));
        let mut one = vec![0u8; 32];
        one[31] = 1;
        let summary = fuzz_database(
            SharedDatabase(Rc::new(RefCell::new(database))),
            transaction,
            block(),
            64,
            0x484f_4f4b_5343_4f50,
            vec![31],
            &[one],
        )
        .expect("masked fork exploration must complete");

        assert_eq!(summary.executions, 64);
        assert!(summary.unique_outcomes >= 2);
        assert!(summary.coverage_edges >= 8);
        assert!(summary.missing_requests.is_empty());
        assert!(summary
            .witnesses
            .iter()
            .all(|witness| witness.calldata.len() == 66
                && witness.calldata[2..64].chars().all(|value| value == '0')));
    }
}
