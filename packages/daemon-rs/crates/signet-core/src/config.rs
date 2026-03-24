use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::constants::{DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_HYBRID_ALPHA, DEFAULT_PORT};

// ---------------------------------------------------------------------------
// Daemon runtime config (resolved from env + agent.yaml)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct DaemonConfig {
    pub base_path: PathBuf,
    pub db_path: PathBuf,
    pub port: u16,
    pub host: String,
    pub bind: Option<String>,
    pub manifest: AgentManifest,
}

impl DaemonConfig {
    pub fn from_env() -> Self {
        let base = std::env::var("SIGNET_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dirs_home().join(".agents"));

        let manifest = load_manifest(&base).unwrap_or_default();
        let (cfg_host, cfg_bind) = resolve_network_binding(
            manifest
                .network
                .as_ref()
                .and_then(|network| network.mode.as_deref()),
        );
        let db = base.join("memory").join("memories.db");
        let port = std::env::var("SIGNET_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_PORT);
        let host_env = std::env::var("SIGNET_HOST").ok();
        let host_from_env = host_env.is_some();
        let bind_env = std::env::var("SIGNET_BIND").ok();
        let host = host_env.unwrap_or_else(|| cfg_host.to_string());
        let bind = bind_env.or_else(|| {
            if host_from_env {
                Some(host.clone())
            } else {
                Some(cfg_bind.to_string())
            }
        });

        Self {
            base_path: base,
            db_path: db,
            port,
            host,
            bind,
            manifest,
        }
    }

    pub fn memory_dir(&self) -> PathBuf {
        self.base_path.join("memory")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.base_path.join(".daemon").join("logs")
    }

    pub fn secrets_dir(&self) -> PathBuf {
        self.base_path.join(".secrets")
    }

    pub fn skills_dir(&self) -> PathBuf {
        self.base_path.join("skills")
    }
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            tracing::warn!(
                "neither HOME nor USERPROFILE is set; falling back to current directory"
            );
            PathBuf::from(".")
        })
}

fn load_manifest(base: &Path) -> Option<AgentManifest> {
    let path = base.join("agent.yaml");
    let content = std::fs::read_to_string(&path).ok()?;
    serde_yml::from_str(&content).ok()
}

fn resolve_network_binding(mode: Option<&str>) -> (&'static str, &'static str) {
    match mode {
        Some("tailscale") => ("127.0.0.1", "0.0.0.0"),
        _ => ("127.0.0.1", "127.0.0.1"),
    }
}

pub fn network_mode_from_bind(bind: &str) -> &'static str {
    match bind {
        "127.0.0.1" | "localhost" | "::1" | "::ffff:127.0.0.1" => "localhost",
        _ => "tailscale",
    }
}

// ---------------------------------------------------------------------------
// AgentManifest (agent.yaml)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentManifest {
    pub version: Option<serde_json::Value>,
    pub schema: Option<String>,
    pub agent: AgentIdentity,
    pub network: Option<NetworkConfig>,
    pub owner: Option<OwnerConfig>,
    pub harnesses: Option<Vec<String>>,
    pub embedding: Option<EmbeddingConfig>,
    pub search: Option<SearchConfig>,
    pub memory: Option<MemoryManifestConfig>,
    pub trust: Option<TrustConfig>,
    pub services: Option<ServicesConfig>,
    pub home: Option<HomeConfig>,
    pub auth: Option<AuthConfig>,
    pub capabilities: Option<Vec<String>>,
    #[serde(rename = "harnessCompatibility")]
    pub harness_compatibility: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NetworkConfig {
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentIdentity {
    pub name: String,
    pub description: Option<String>,
    pub created: Option<String>,
    pub updated: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OwnerConfig {
    pub address: Option<String>,
    #[serde(rename = "localId")]
    pub local_id: Option<String>,
    pub ens: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingConfig {
    pub provider: String,
    pub model: String,
    pub dimensions: usize,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

impl Default for EmbeddingConfig {
    fn default() -> Self {
        Self {
            provider: "ollama".to_string(),
            model: "nomic-embed-text".to_string(),
            dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
            base_url: None,
            api_key: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{network_mode_from_bind, resolve_network_binding};

    #[test]
    fn resolves_localhost_binding_by_default() {
        assert_eq!(resolve_network_binding(None), ("127.0.0.1", "127.0.0.1"));
    }

    #[test]
    fn resolves_tailscale_binding_from_manifest() {
        assert_eq!(
            resolve_network_binding(Some("tailscale")),
            ("127.0.0.1", "0.0.0.0")
        );
    }

    #[test]
    fn infers_network_mode_from_bind_host() {
        assert_eq!(network_mode_from_bind("127.0.0.1"), "localhost");
        assert_eq!(network_mode_from_bind("0.0.0.0"), "tailscale");
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchConfig {
    pub alpha: f64,
    pub top_k: usize,
    pub min_score: f64,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            alpha: DEFAULT_HYBRID_ALPHA,
            top_k: 20,
            min_score: 0.1,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MemoryManifestConfig {
    pub database: Option<String>,
    pub vectors: Option<String>,
    pub session_budget: Option<usize>,
    pub decay_rate: Option<f64>,
    #[serde(rename = "pipelineV2")]
    pub pipeline_v2: Option<PipelineV2Config>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustConfig {
    pub verification: String,
    pub registry: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServicesConfig {
    pub openclaw: Option<OpenClawServiceConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenClawServiceConfig {
    pub restart_command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HomeConfig {
    #[serde(rename = "spotlightEntity")]
    pub spotlight_entity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthConfig {
    pub method: String,
    #[serde(rename = "chainId")]
    pub chain_id: Option<u64>,
    pub mode: Option<String>,
    #[serde(rename = "rateLimits")]
    pub rate_limits: Option<HashMap<String, RateLimitConfig>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RateLimitConfig {
    #[serde(rename = "windowMs")]
    pub window_ms: Option<u64>,
    pub max: Option<u64>,
}

// ---------------------------------------------------------------------------
// Pipeline V2 Config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PipelineV2Config {
    pub enabled: bool,
    pub shadow_mode: bool,
    /// Spawn the native Rust daemon as a shadow on :3851. Distinct from
    /// `shadow_mode` (extract-without-write). Only meaningful when read
    /// by the TS daemon; the Rust daemon ignores this field at runtime.
    pub native_shadow_enabled: bool,
    pub mutations_frozen: bool,
    pub semantic_contradiction_enabled: bool,
    pub semantic_contradiction_timeout_ms: u64,
    pub telemetry_enabled: bool,
    pub extraction: ExtractionConfig,
    pub worker: WorkerConfig,
    pub graph: GraphConfig,
    pub traversal: Option<TraversalConfig>,
    pub reranker: RerankerConfig,
    pub autonomous: AutonomousConfig,
    pub repair: RepairConfig,
    pub documents: DocumentsConfig,
    pub guardrails: GuardrailsConfig,
    pub telemetry: TelemetryConfig,
    pub continuity: ContinuityConfig,
    pub embedding_tracker: EmbeddingTrackerConfig,
    pub synthesis: SynthesisConfig,
    pub procedural: ProceduralConfig,
    pub structural: StructuralConfig,
    pub feedback: FeedbackConfig,
    pub significance: Option<SignificanceConfig>,
    pub predictor: Option<PredictorConfig>,
    pub predictor_pipeline: PredictorPipelineConfig,
    pub model_registry: ModelRegistryConfig,
}

impl Default for PipelineV2Config {
    fn default() -> Self {
        Self {
            enabled: true,
            shadow_mode: false,
            native_shadow_enabled: false,
            mutations_frozen: false,
            semantic_contradiction_enabled: true,
            semantic_contradiction_timeout_ms: 120_000,
            telemetry_enabled: false,
            extraction: ExtractionConfig::default(),
            worker: WorkerConfig::default(),
            graph: GraphConfig::default(),
            traversal: Some(TraversalConfig::default()),
            reranker: RerankerConfig::default(),
            autonomous: AutonomousConfig::default(),
            repair: RepairConfig::default(),
            documents: DocumentsConfig::default(),
            guardrails: GuardrailsConfig::default(),
            telemetry: TelemetryConfig::default(),
            continuity: ContinuityConfig::default(),
            embedding_tracker: EmbeddingTrackerConfig::default(),
            synthesis: SynthesisConfig::default(),
            procedural: ProceduralConfig::default(),
            structural: StructuralConfig::default(),
            feedback: FeedbackConfig::default(),
            significance: Some(SignificanceConfig::default()),
            predictor: Some(PredictorConfig::default()),
            predictor_pipeline: PredictorPipelineConfig::default(),
            model_registry: ModelRegistryConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExtractionConfig {
    pub provider: String,
    pub model: String,
    pub strength: String,
    pub endpoint: Option<String>,
    pub timeout: u64,
    pub min_confidence: f64,
    pub escalation: Option<EscalationConfig>,
}

impl Default for ExtractionConfig {
    fn default() -> Self {
        Self {
            provider: "ollama".to_string(),
            model: "qwen3:4b".to_string(),
            strength: "medium".to_string(),
            endpoint: None,
            timeout: 30_000,
            min_confidence: 0.5,
            escalation: Some(EscalationConfig::default()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EscalationConfig {
    pub max_new_entities_per_chunk: usize,
    pub max_new_attributes_per_entity: usize,
    pub level2_max_entities: usize,
}

impl Default for EscalationConfig {
    fn default() -> Self {
        Self {
            max_new_entities_per_chunk: 3,
            max_new_attributes_per_entity: 5,
            level2_max_entities: 10,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkerConfig {
    pub poll_ms: u64,
    pub max_retries: u32,
    pub lease_timeout_ms: u64,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            poll_ms: 2_000,
            max_retries: 3,
            lease_timeout_ms: 60_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GraphConfig {
    pub enabled: bool,
    pub boost_weight: f64,
    pub boost_timeout_ms: u64,
}

impl Default for GraphConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            boost_weight: 0.15,
            boost_timeout_ms: 2_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TraversalConfig {
    pub enabled: bool,
    pub max_aspects_per_entity: usize,
    pub max_attributes_per_aspect: usize,
    pub max_dependency_hops: usize,
    pub min_dependency_strength: f64,
    pub timeout_ms: u64,
    pub boost_weight: f64,
    pub constraint_budget_chars: usize,
}

impl Default for TraversalConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_aspects_per_entity: 5,
            max_attributes_per_aspect: 3,
            max_dependency_hops: 2,
            min_dependency_strength: 0.3,
            timeout_ms: 3_000,
            boost_weight: 0.1,
            constraint_budget_chars: 4_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RerankerConfig {
    pub enabled: bool,
    pub model: String,
    pub top_n: usize,
    pub timeout_ms: u64,
}

impl Default for RerankerConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            model: "nomic-embed-text".to_string(),
            top_n: 10,
            timeout_ms: 5_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AutonomousConfig {
    pub enabled: bool,
    pub frozen: bool,
    pub allow_update_delete: bool,
    pub maintenance_interval_ms: u64,
    pub maintenance_mode: String,
}

impl Default for AutonomousConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            frozen: false,
            allow_update_delete: false,
            maintenance_interval_ms: 3_600_000,
            maintenance_mode: "observe".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RepairConfig {
    pub reembed_cooldown_ms: u64,
    pub reembed_hourly_budget: u64,
    pub requeue_cooldown_ms: u64,
    pub requeue_hourly_budget: u64,
    pub dedup_cooldown_ms: u64,
    pub dedup_hourly_budget: u64,
    pub dedup_semantic_threshold: f64,
    pub dedup_batch_size: usize,
}

impl Default for RepairConfig {
    fn default() -> Self {
        Self {
            reembed_cooldown_ms: 300_000,
            reembed_hourly_budget: 100,
            requeue_cooldown_ms: 60_000,
            requeue_hourly_budget: 50,
            dedup_cooldown_ms: 600_000,
            dedup_hourly_budget: 20,
            dedup_semantic_threshold: 0.92,
            dedup_batch_size: 50,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DocumentsConfig {
    pub worker_interval_ms: u64,
    pub chunk_size: usize,
    pub chunk_overlap: usize,
    pub max_content_bytes: usize,
}

impl Default for DocumentsConfig {
    fn default() -> Self {
        Self {
            worker_interval_ms: 5_000,
            chunk_size: 1_500,
            chunk_overlap: 200,
            max_content_bytes: 10_000_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GuardrailsConfig {
    pub max_content_chars: usize,
    pub chunk_target_chars: usize,
    pub recall_truncate_chars: usize,
}

impl Default for GuardrailsConfig {
    fn default() -> Self {
        Self {
            max_content_chars: 10_000,
            chunk_target_chars: 2_000,
            recall_truncate_chars: 50_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TelemetryConfig {
    pub posthog_host: String,
    pub posthog_api_key: String,
    pub flush_interval_ms: u64,
    pub flush_batch_size: usize,
    pub retention_days: u64,
}

impl Default for TelemetryConfig {
    fn default() -> Self {
        Self {
            posthog_host: String::new(),
            posthog_api_key: String::new(),
            flush_interval_ms: 60_000,
            flush_batch_size: 50,
            retention_days: 30,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ContinuityConfig {
    pub enabled: bool,
    pub prompt_interval: u64,
    pub time_interval_ms: u64,
    pub max_checkpoints_per_session: usize,
    pub retention_days: u64,
    pub recovery_budget_chars: usize,
}

impl Default for ContinuityConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            prompt_interval: 5,
            time_interval_ms: 300_000,
            max_checkpoints_per_session: 10,
            retention_days: 30,
            recovery_budget_chars: 8_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EmbeddingTrackerConfig {
    pub enabled: bool,
    pub poll_ms: u64,
    pub batch_size: usize,
}

impl Default for EmbeddingTrackerConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            poll_ms: 5_000,
            batch_size: 50,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SynthesisConfig {
    pub enabled: bool,
    pub provider: String,
    pub model: String,
    pub endpoint: Option<String>,
    pub timeout: u64,
    pub max_tokens: usize,
    pub idle_gap_minutes: u64,
}

impl Default for SynthesisConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            provider: "ollama".to_string(),
            model: "qwen3:4b".to_string(),
            endpoint: None,
            timeout: 60_000,
            max_tokens: 4_096,
            idle_gap_minutes: 30,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProceduralConfig {
    pub enabled: bool,
    pub decay_rate: f64,
    pub min_importance: f64,
    pub importance_on_install: f64,
    pub enrich_on_install: bool,
    pub enrich_min_description: usize,
    pub reconcile_interval_ms: u64,
}

impl Default for ProceduralConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            decay_rate: 0.99,
            min_importance: 0.1,
            importance_on_install: 0.7,
            enrich_on_install: true,
            enrich_min_description: 50,
            reconcile_interval_ms: 300_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StructuralConfig {
    pub enabled: bool,
    pub classify_batch_size: usize,
    pub dependency_batch_size: usize,
    pub poll_interval_ms: u64,
    pub synthesis_enabled: bool,
    pub synthesis_interval_ms: u64,
    pub synthesis_top_entities: usize,
    pub synthesis_max_facts: usize,
}

impl Default for StructuralConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            classify_batch_size: 10,
            dependency_batch_size: 10,
            poll_interval_ms: 10_000,
            synthesis_enabled: true,
            synthesis_interval_ms: 60_000,
            synthesis_top_entities: 20,
            synthesis_max_facts: 10,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FeedbackConfig {
    pub enabled: bool,
    pub fts_weight_delta: f64,
    pub max_aspect_weight: f64,
    pub min_aspect_weight: f64,
    pub decay_enabled: bool,
    pub decay_rate: f64,
    pub stale_days: u64,
    pub decay_interval_sessions: u64,
}

impl Default for FeedbackConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            fts_weight_delta: 0.05,
            max_aspect_weight: 2.0,
            min_aspect_weight: 0.1,
            decay_enabled: true,
            decay_rate: 0.95,
            stale_days: 30,
            decay_interval_sessions: 5,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SignificanceConfig {
    pub enabled: bool,
    pub min_turns: usize,
    pub min_entity_overlap: usize,
    pub novelty_threshold: f64,
}

impl Default for SignificanceConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            min_turns: 3,
            min_entity_overlap: 1,
            novelty_threshold: 0.3,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PredictorConfig {
    pub enabled: bool,
    pub train_interval_sessions: u64,
    pub min_training_sessions: u64,
    pub score_timeout_ms: u64,
    pub train_timeout_ms: u64,
    pub crash_disable_threshold: u64,
    pub rrf_k: f64,
    pub exploration_rate: f64,
    pub drift_reset_window: u64,
    pub binary_path: Option<String>,
    pub binary_args: Option<Vec<String>>,
    pub checkpoint_path: Option<String>,
}

impl Default for PredictorConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            train_interval_sessions: 5,
            min_training_sessions: 10,
            score_timeout_ms: 5_000,
            train_timeout_ms: 30_000,
            crash_disable_threshold: 3,
            rrf_k: 60.0,
            exploration_rate: 0.1,
            drift_reset_window: 50,
            binary_path: None,
            binary_args: None,
            checkpoint_path: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PredictorPipelineConfig {
    pub agent_feedback: bool,
    pub training_telemetry: bool,
}

impl Default for PredictorPipelineConfig {
    fn default() -> Self {
        Self {
            agent_feedback: true,
            training_telemetry: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelRegistryConfig {
    pub enabled: bool,
    pub refresh_interval_ms: u64,
}

impl Default for ModelRegistryConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            refresh_interval_ms: 3_600_000,
        }
    }
}
