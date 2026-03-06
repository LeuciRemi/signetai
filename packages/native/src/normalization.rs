use napi_derive::napi;
use sha2::{Digest, Sha256};

// napi(object) converts snake_case fields to camelCase in JS:
// storage_content -> storageContent, etc.
#[napi(object)]
pub struct NormalizedMemoryContent {
    pub storage_content: String,
    pub normalized_content: String,
    pub hash_basis: String,
    pub content_hash: String,
}

#[napi]
pub fn normalize_content_for_storage(content: String) -> String {
    let trimmed = content.trim();
    let mut result = String::with_capacity(trimmed.len());
    let mut prev_whitespace = false;

    for ch in trimmed.chars() {
        if ch.is_whitespace() {
            if !prev_whitespace {
                result.push(' ');
            }
            prev_whitespace = true;
        } else {
            result.push(ch);
            prev_whitespace = false;
        }
    }

    result
}

#[napi]
pub fn derive_normalized_content(storage_content: String) -> String {
    let lowered = storage_content.to_lowercase();
    // Parity: TS uses /[.,!?;:]+$/ regex. trim_end_matches char-by-char
    // is equivalent here since input is already trimmed of whitespace.
    let trimmed = lowered.trim_end_matches(|c: char| matches!(c, '.' | ',' | '!' | '?' | ';' | ':'));
    trimmed.trim().to_string()
}

#[napi]
pub fn normalize_and_hash_content(content: String) -> NormalizedMemoryContent {
    let storage_content = normalize_content_for_storage(content);
    let normalized_content = derive_normalized_content(storage_content.clone());

    let hash_basis = if normalized_content.is_empty() {
        storage_content.to_lowercase()
    } else {
        normalized_content.clone()
    };

    let mut hasher = Sha256::new();
    hasher.update(hash_basis.as_bytes());
    let content_hash = format!("{:x}", hasher.finalize());

    NormalizedMemoryContent {
        storage_content,
        normalized_content,
        hash_basis,
        content_hash,
    }
}
