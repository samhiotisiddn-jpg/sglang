//! Shared MCP utilities for routers.
//!
//! This module provides shared MCP-related functionality that can be
//! used across different router implementations (OpenAI, gRPC regular, gRPC harmony).

use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;
use smg_mcp::{McpManager, McpServerConfig, McpTransport};
use tracing::warn;

use crate::protocols::responses::{ResponseTool, ResponseToolType, ResponsesRequest};

// ============================================================================
// Constants
// ============================================================================

/// Default maximum tool loop iterations (safety limit).
///
/// Used as fallback when user doesn't specify `max_tool_calls`.
/// All routers use this same value.
pub const DEFAULT_MAX_ITERATIONS: usize = 10;
pub const MCP_CONTEXT_BOUNDARY_START: &str = "<mcp_context_untrusted>";
pub const MCP_CONTEXT_BOUNDARY_END: &str = "</mcp_context_untrusted>";

#[derive(Debug, Clone, Deserialize)]
pub struct AgenticBehaviorCertificate {
    pub agent_id: String,
    #[serde(default)]
    pub permissions: Value,
    #[serde(default)]
    pub functions: Vec<BehaviorFunctionPermission>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BehaviorFunctionPermission {
    pub name: String,
    #[serde(default)]
    pub critical: bool,
}

// ============================================================================
// Configuration
// ============================================================================

/// Configuration for MCP tool calling loops.
///
/// Provides a common structure for loop configuration across routers.
#[derive(Debug, Clone)]
pub struct McpLoopConfig {
    /// Maximum iterations as safety limit (default: DEFAULT_MAX_ITERATIONS).
    /// Prevents infinite loops when max_tool_calls is not set by user.
    pub max_iterations: usize,
    /// Server keys for filtering MCP tools.
    /// Contains keys for dynamic servers that were connected for this request.
    pub server_keys: Vec<String>,
}

impl Default for McpLoopConfig {
    fn default() -> Self {
        Self {
            max_iterations: DEFAULT_MAX_ITERATIONS,
            server_keys: Vec::new(),
        }
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Extract MCP server label from request tools.
///
/// Searches for the first MCP tool in the tools array and returns its server_label.
/// Falls back to a default value if no MCP tool with server_label is found.
pub fn extract_server_label(tools: Option<&[ResponseTool]>, default_label: &str) -> String {
    tools
        .and_then(|tools| {
            tools.iter().find_map(|tool| {
                if matches!(tool.r#type, ResponseToolType::Mcp) {
                    tool.server_label.clone()
                } else {
                    None
                }
            })
        })
        .unwrap_or_else(|| default_label.to_string())
}

/// Extract and validate behavior certificate from request metadata.
///
/// Accepted metadata keys:
/// - `agentic_behavior_certificate`
/// - `behavior_certificate`
pub fn extract_behavior_certificate(
    request: &ResponsesRequest,
) -> Result<Option<AgenticBehaviorCertificate>, String> {
    let Some(metadata) = request.metadata.as_ref() else {
        return Ok(None);
    };

    let Some(raw_cert) = metadata
        .get("agentic_behavior_certificate")
        .or_else(|| metadata.get("behavior_certificate"))
    else {
        return Ok(None);
    };

    let cert: AgenticBehaviorCertificate = match raw_cert {
        Value::String(s) => serde_json::from_str(s)
            .map_err(|e| format!("Invalid behavior certificate JSON string: {}", e))?,
        other => serde_json::from_value(other.clone())
            .map_err(|e| format!("Invalid behavior certificate object: {}", e))?,
    };

    if cert.agent_id.trim().is_empty() {
        return Err("Behavior certificate requires non-empty agent_id".to_string());
    }
    if cert.functions.is_empty() {
        return Err("Behavior certificate requires at least one function rule".to_string());
    }

    Ok(Some(cert))
}

/// Check whether a tool call is allowed by behavior certificate function rules.
pub fn is_tool_allowed_by_certificate(cert: &AgenticBehaviorCertificate, tool_name: &str) -> bool {
    let tool_name = tool_name.trim();
    cert.functions.iter().any(|rule| {
        let rule_name = rule.name.trim();
        rule_name.eq_ignore_ascii_case(tool_name)
            || rule_name.eq_ignore_ascii_case(&format!("call:{}", tool_name))
    })
}

/// Enforce tool-call permissions from behavior certificate.
pub fn enforce_tool_call_certificate(
    cert: Option<&AgenticBehaviorCertificate>,
    tool_name: &str,
) -> Result<(), String> {
    let Some(cert) = cert else {
        return Err("MCP tool execution requires an agentic behavior certificate".to_string());
    };

    if is_tool_allowed_by_certificate(cert, tool_name) {
        Ok(())
    } else {
        Err(format!(
            "Tool '{}' is not allowed by behavior certificate for agent '{}'",
            tool_name, cert.agent_id
        ))
    }
}

/// XML-escape external content before wrapping it in prompt-boundary tags.
fn xml_escape(s: &str) -> String {
    let mut escaped = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

/// Wrap untrusted MCP output so it cannot silently blend into system/user prompt context.
pub fn wrap_mcp_output_for_prompt(output: &str) -> String {
    format!(
        "{}\n{}\n{}",
        MCP_CONTEXT_BOUNDARY_START,
        xml_escape(output),
        MCP_CONTEXT_BOUNDARY_END
    )
}

/// Extract an x402/MPP payment token from request metadata.
///
/// Supported metadata forms:
/// - `x402_payment: "token"`
/// - `x_payment: "token"`
/// - `x402: { "payment": "token" }`
pub fn extract_x_payment_token(request: &ResponsesRequest) -> Option<String> {
    let metadata = request.metadata.as_ref()?;

    let direct = metadata
        .get("x402_payment")
        .or_else(|| metadata.get("x_payment"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if direct.is_some() {
        return direct;
    }

    metadata
        .get("x402")
        .and_then(|v| v.as_object())
        .and_then(|obj| obj.get("payment"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

// ============================================================================
// MCP Connection
// ============================================================================

/// Ensure MCP clients are connected for all request-level MCP tools.
///
/// This function extracts MCP server configurations from ALL request tools (server_url, authorization)
/// and ensures client connections are established via the connection pool.
///
/// Returns `Some((manager, server_keys))` if MCP tools were found and clients created,
/// `None` if no MCP tools with server_url were found.
pub async fn ensure_request_mcp_client(
    mcp_manager: &Arc<McpManager>,
    tools: &[ResponseTool],
    behavior_certificate: Option<&AgenticBehaviorCertificate>,
) -> Result<Option<(Arc<McpManager>, Vec<String>)>, String> {
    let mut server_keys = Vec::new();
    let mut has_mcp_tools = false;

    // Process all MCP tools
    for tool in tools {
        if matches!(tool.r#type, ResponseToolType::Mcp) && tool.server_url.is_some() {
            has_mcp_tools = true;

            if behavior_certificate.is_none() {
                return Err("MCP tools require `metadata.agentic_behavior_certificate`".to_string());
            }

            if let (Some(cert), Some(allowed_tools)) = (behavior_certificate, &tool.allowed_tools) {
                for allowed_tool in allowed_tools {
                    enforce_tool_call_certificate(Some(cert), allowed_tool)?;
                }
            }

            let Some(server_url) = tool.server_url.as_ref().map(|s| s.trim().to_string()) else {
                continue;
            };

            // Validate URL scheme
            if !(server_url.starts_with("http://") || server_url.starts_with("https://")) {
                warn!(
                    "Ignoring MCP server_url with unsupported scheme: {}",
                    server_url
                );
                continue;
            }

            // Extract server label and auth token
            let name = tool
                .server_label
                .clone()
                .unwrap_or_else(|| "request-mcp".to_string());
            let token = tool.authorization.clone();

            // Determine transport type based on URL pattern
            let transport = if server_url.contains("/sse") {
                McpTransport::Sse {
                    url: server_url.clone(),
                    token,
                }
            } else {
                McpTransport::Streamable {
                    url: server_url.clone(),
                    token,
                }
            };

            // Create server config
            let server_config = McpServerConfig {
                name,
                transport,
                proxy: None,
                required: false,
            };

            // Get the server key for tracking
            let server_key = McpManager::server_key(&server_config);

            // Use get_or_create_client to establish connection
            match mcp_manager.get_or_create_client(server_config).await {
                Ok(_client) => {
                    // Track this server for filtering
                    if !server_keys.contains(&server_key) {
                        server_keys.push(server_key);
                    }
                }
                Err(err) => {
                    warn!(
                        "Failed to get/create MCP connection for {}: {}",
                        server_key, err
                    );
                    // Continue processing other tools
                }
            }
        }
    }

    if has_mcp_tools && !server_keys.is_empty() {
        Ok(Some((mcp_manager.clone(), server_keys)))
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_tool_allowed_by_certificate_with_call_prefix() {
        let cert = AgenticBehaviorCertificate {
            agent_id: "agent-1".to_string(),
            permissions: json!({}),
            functions: vec![BehaviorFunctionPermission {
                name: "call:email.read_message".to_string(),
                critical: true,
            }],
        };
        assert!(is_tool_allowed_by_certificate(&cert, "email.read_message"));
        assert!(!is_tool_allowed_by_certificate(
            &cert,
            "email.delete_message"
        ));
    }

    #[test]
    fn test_wrap_mcp_output_for_prompt_escapes_markup() {
        let wrapped = wrap_mcp_output_for_prompt("<script>alert('x')</script>");
        assert!(wrapped.starts_with(MCP_CONTEXT_BOUNDARY_START));
        assert!(wrapped.ends_with(MCP_CONTEXT_BOUNDARY_END));
        assert!(wrapped.contains("&lt;script&gt;alert(&apos;x&apos;)&lt;/script&gt;"));
    }
}
