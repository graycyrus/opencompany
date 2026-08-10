//! The workspace REST surface: read the tree, read one node, create a node,
//! overwrite a file, rename/move a node, and delete (folders recursive) — under
//! both scope forms.
//!
//! Bodies mirror the console's `FsNode` (`frontend/src/lib/workspace.ts`).
//! Reads and writes both go through the
//! [`WorkspaceStore`](crate::ports::WorkspaceStore); node ids are stable ULIDs
//! so a rename/move never breaks a reference.
//!
//! The reads exist so the console's Workspace tab renders the *company's*
//! workspace — the one agents write through the code/shell capability — rather
//! than a per-browser scratchpad (issue #177). A parallel read lives on the
//! GraphQL surface (`Company.workspaceTree`); this is the REST twin the console
//! client speaks.

use axum::extract::Path;
use axum::http::StatusCode;
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::error::OpenCompanyError;
use crate::ports::generate_id;
use crate::ports::workspace::{NodeKind, WorkspaceNode};
use crate::server::error::ApiError;
use crate::server::ops::{ScopedCompany, scoped};

/// Builds the workspace route fragment.
///
/// Each path is registered as a single `MethodRouter` — axum rejects two
/// registrations of the same path, so the read verbs chain onto the write ones
/// rather than merging a second router for the same suffix.
pub fn router() -> Router<AppState> {
    scoped("/workspace", get(list_tree).post(create_node))
        .merge(scoped("/workspace/file/{node_id}", put(write_file)))
        .merge(scoped(
            "/workspace/{node_id}",
            get(read_node).patch(rename_move).delete(delete_node),
        ))
}

/// A workspace node as the console renders it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsNode {
    id: String,
    name: String,
    kind: NodeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    updated_at: u64,
}

impl FsNode {
    fn from_node(node: WorkspaceNode, content: Option<String>) -> Self {
        Self {
            id: node.id,
            name: node.name,
            kind: node.kind,
            parent_id: node.parent_id,
            content,
            updated_at: node.updated_at_millis,
        }
    }
}

/// The create-node body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateNode {
    name: String,
    kind: NodeKind,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default)]
    content: Option<String>,
}

/// The overwrite-file body.
#[derive(Debug, Deserialize)]
struct WriteFile {
    content: String,
}

/// The rename/move body.
///
/// `parent_id` uses a double option so an omitted `parentId` (leave the parent
/// unchanged) is distinguished from an explicit `"parentId": null` (move the
/// node back to the workspace root).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameMove {
    #[serde(default)]
    name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    parent_id: Option<Option<String>>,
}

/// Deserializes into `Some(inner)` when the field is present (so an explicit
/// `null` becomes `Some(None)`); the `#[serde(default)]` leaves an omitted field
/// as `None`.
fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(deserializer).map(Some)
}

/// The overwrite-file response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteAck {
    updated_at: u64,
}

/// The sub-resource path (`node_id`).
#[derive(Debug, Deserialize)]
struct NodePath {
    node_id: String,
}

/// `GET …/workspace` — every node in the company's tree, file bodies inlined.
///
/// Bodies are inlined deliberately. The console renders `[[wiki link]]`
/// backlinks, and "which notes link here" is a whole-tree question: a
/// bodyless listing would force the client to fetch every file anyway, so
/// inlining costs the same reads and one round trip instead of N.
///
/// The tree is unordered — callers build the hierarchy from `parentId`, which
/// is absent on a node at the workspace root.
async fn list_tree(company: ScopedCompany) -> Result<Json<Vec<FsNode>>, ApiError> {
    let workspace = company.runtime.workspace();
    let nodes = workspace.tree(company.id()).await?;
    let mut out = Vec::with_capacity(nodes.len());
    for node in nodes {
        let content = match node.kind {
            NodeKind::File => workspace
                .read(company.id(), &node.id)
                .await?
                .map(|(_, body)| body),
            NodeKind::Folder => None,
        };
        out.push(FsNode::from_node(node, content));
    }
    Ok(Json(out))
}

/// `GET …/workspace/{node_id}` — one node, with its body when it is a file.
/// 404s when the id names nothing in this company's workspace.
async fn read_node(
    company: ScopedCompany,
    Path(NodePath { node_id }): Path<NodePath>,
) -> Result<Json<FsNode>, ApiError> {
    let (node, body) = company
        .runtime
        .workspace()
        .read(company.id(), &node_id)
        .await?
        .ok_or_else(|| {
            ApiError(OpenCompanyError::NotFound(format!(
                "workspace node {node_id}"
            )))
        })?;
    let content = match node.kind {
        NodeKind::File => Some(body),
        NodeKind::Folder => None,
    };
    Ok(Json(FsNode::from_node(node, content)))
}

async fn create_node(
    company: ScopedCompany,
    Json(body): Json<CreateNode>,
) -> Result<Json<FsNode>, ApiError> {
    let node = WorkspaceNode {
        id: generate_id(),
        name: body.name,
        kind: body.kind,
        parent_id: body.parent_id,
        updated_at_millis: crate::ports::now_millis(),
    };
    company
        .runtime
        .workspace()
        .create(company.id(), &node, body.content.as_deref())
        .await?;
    let content = match node.kind {
        NodeKind::File => Some(body.content.unwrap_or_default()),
        NodeKind::Folder => None,
    };
    Ok(Json(FsNode::from_node(node, content)))
}

async fn write_file(
    company: ScopedCompany,
    Path(NodePath { node_id }): Path<NodePath>,
    Json(body): Json<WriteFile>,
) -> Result<Json<WriteAck>, ApiError> {
    let node = company
        .runtime
        .workspace()
        .write(company.id(), &node_id, &body.content)
        .await?;
    Ok(Json(WriteAck {
        updated_at: node.updated_at_millis,
    }))
}

async fn rename_move(
    company: ScopedCompany,
    Path(NodePath { node_id }): Path<NodePath>,
    Json(body): Json<RenameMove>,
) -> Result<Json<FsNode>, ApiError> {
    let node = company
        .runtime
        .workspace()
        .rename_move(
            company.id(),
            &node_id,
            body.name.as_deref(),
            body.parent_id.as_ref().map(Option::as_deref),
        )
        .await?;
    let content = match node.kind {
        NodeKind::File => company
            .runtime
            .workspace()
            .read(company.id(), &node_id)
            .await?
            .map(|(_, body)| body),
        NodeKind::Folder => None,
    };
    Ok(Json(FsNode::from_node(node, content)))
}

async fn delete_node(
    company: ScopedCompany,
    Path(NodePath { node_id }): Path<NodePath>,
) -> Result<StatusCode, ApiError> {
    if company
        .runtime
        .workspace()
        .delete(company.id(), &node_id)
        .await?
    {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError(OpenCompanyError::CompanyNotFound(format!(
            "workspace node {node_id}"
        ))))
    }
}
