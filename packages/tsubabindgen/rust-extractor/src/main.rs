use quote::ToTokens;
use serde::Serialize;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use syn::{
    Fields, FnArg, GenericParam, ImplItem, Item, ItemConst, ItemEnum, ItemImpl, ItemMod,
    ItemStruct, ItemTrait, Pat, ReturnType, Signature, TraitItem, Type, Visibility,
};

#[derive(Serialize, Clone)]
struct SkipIssue {
    file: String,
    kind: String,
    snippet: String,
    reason: String,
}

#[derive(Serialize, Clone)]
struct ExtractField {
    name: String,
    #[serde(rename = "type")]
    type_text: String,
}

#[derive(Serialize, Clone)]
struct ExtractFunction {
    name: String,
    #[serde(rename = "typeParams")]
    type_params: Vec<String>,
    params: Vec<ExtractField>,
    #[serde(rename = "returnType")]
    return_type: String,
}

#[derive(Serialize, Clone)]
struct ExtractStruct {
    name: String,
    #[serde(rename = "typeParams")]
    type_params: Vec<String>,
    fields: Vec<ExtractField>,
}

#[derive(Serialize, Clone)]
struct ExtractEnum {
    name: String,
    #[serde(rename = "typeParams")]
    type_params: Vec<String>,
    variants: Vec<String>,
}

#[derive(Serialize, Clone)]
struct ExtractTrait {
    name: String,
    #[serde(rename = "typeParams")]
    type_params: Vec<String>,
    #[serde(rename = "superTraits")]
    super_traits: Vec<String>,
    methods: Vec<ExtractFunction>,
}

#[derive(Serialize, Clone)]
struct PendingMethods {
    target: String,
    methods: Vec<ExtractFunction>,
}

#[derive(Serialize, Clone)]
struct ExtractModule {
    file: String,
    parts: Vec<String>,
    consts: Vec<ExtractField>,
    enums: Vec<ExtractEnum>,
    structs: Vec<ExtractStruct>,
    traits: Vec<ExtractTrait>,
    functions: Vec<ExtractFunction>,
    #[serde(rename = "pendingMethods")]
    pending_methods: Vec<PendingMethods>,
    issues: Vec<SkipIssue>,
}

#[derive(Serialize)]
struct ExtractOutput {
    schema: u32,
    modules: Vec<ExtractModule>,
}

fn macro_stub(name: String) -> ExtractFunction {
    ExtractFunction {
        name,
        type_params: Vec::new(),
        params: vec![ExtractField {
            name: "tokens".to_string(),
            type_text: "Tokens".to_string(),
        }],
        return_type: "Tokens".to_string(),
    }
}

fn is_public(vis: &Visibility) -> bool {
    matches!(vis, Visibility::Public(_))
}

fn normalize_ws(text: String) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn type_to_string(ty: &Type) -> String {
    normalize_ws(ty.to_token_stream().to_string())
}

fn return_type_to_string(ret: &ReturnType) -> String {
    match ret {
        ReturnType::Default => "()".to_string(),
        ReturnType::Type(_, ty) => type_to_string(ty),
    }
}

fn parse_type_params(
    generics: &syn::Generics,
    file: &str,
    owner_kind: &str,
    owner_name: &str,
    issues: &mut Vec<SkipIssue>,
) -> Vec<String> {
    let mut out = Vec::new();
    for param in &generics.params {
        match param {
            GenericParam::Type(tp) => out.push(tp.ident.to_string()),
            GenericParam::Lifetime(lp) => issues.push(SkipIssue {
                file: file.to_string(),
                kind: "generic".to_string(),
                snippet: lp.to_token_stream().to_string(),
                reason: format!(
                    "{owner_kind} '{owner_name}' lifetime generic parameters are not representable in TS facades and were skipped."
                ),
            }),
            GenericParam::Const(cp) => issues.push(SkipIssue {
                file: file.to_string(),
                kind: "generic".to_string(),
                snippet: cp.to_token_stream().to_string(),
                reason: format!(
                    "{owner_kind} '{owner_name}' const generic parameters are not representable in TS facades and were skipped."
                ),
            }),
        }
    }
    out
}

fn parse_signature(sig: &Signature, file: &str, issues: &mut Vec<SkipIssue>) -> ExtractFunction {
    let type_params = parse_type_params(&sig.generics, file, "Function", &sig.ident.to_string(), issues);
    let mut params = Vec::new();
    for input in &sig.inputs {
        match input {
            FnArg::Receiver(receiver) => {
                let name = if receiver.reference.is_some() && receiver.mutability.is_some() {
                    "&mut self".to_string()
                } else if receiver.reference.is_some() {
                    "&self".to_string()
                } else {
                    "self".to_string()
                };
                params.push(ExtractField {
                    name,
                    type_text: "self".to_string(),
                });
            }
            FnArg::Typed(arg) => {
                let name = if let Pat::Ident(ident) = arg.pat.as_ref() {
                    ident.ident.to_string()
                } else {
                    issues.push(SkipIssue {
                        file: file.to_string(),
                        kind: "param".to_string(),
                        snippet: arg.pat.to_token_stream().to_string(),
                        reason: "Non-identifier function parameters are not representable in TS facades and were replaced by an 'unsupported' name.".to_string(),
                    });
                    "unsupported".to_string()
                };
                params.push(ExtractField {
                    name,
                    type_text: type_to_string(arg.ty.as_ref()),
                });
            }
        }
    }
    ExtractFunction {
        name: sig.ident.to_string(),
        type_params,
        params,
        return_type: return_type_to_string(&sig.output),
    }
}

fn parse_const(item: &ItemConst) -> ExtractField {
    ExtractField {
        name: item.ident.to_string(),
        type_text: type_to_string(item.ty.as_ref()),
    }
}

fn parse_struct(item: &ItemStruct, file: &str, issues: &mut Vec<SkipIssue>) -> ExtractStruct {
    let type_params = parse_type_params(&item.generics, file, "Struct", &item.ident.to_string(), issues);
    let mut fields = Vec::new();
    match &item.fields {
        Fields::Named(named) => {
            for field in &named.named {
                if !is_public(&field.vis) {
                    continue;
                }
                if let Some(name) = &field.ident {
                    fields.push(ExtractField {
                        name: name.to_string(),
                        type_text: type_to_string(&field.ty),
                    });
                }
            }
        }
        Fields::Unnamed(_) => issues.push(SkipIssue {
            file: file.to_string(),
            kind: "struct".to_string(),
            snippet: item.ident.to_string(),
            reason: "Tuple structs are not representable as TS class fields and were emitted without fields."
                .to_string(),
        }),
        Fields::Unit => {}
    }
    ExtractStruct {
        name: item.ident.to_string(),
        type_params,
        fields,
    }
}

fn parse_enum(item: &ItemEnum, file: &str, issues: &mut Vec<SkipIssue>) -> ExtractEnum {
    let type_params = parse_type_params(&item.generics, file, "Enum", &item.ident.to_string(), issues);
    let mut variants = Vec::new();
    for variant in &item.variants {
        if !matches!(variant.fields, Fields::Unit) {
            issues.push(SkipIssue {
                file: file.to_string(),
                kind: "enum".to_string(),
                snippet: variant.ident.to_string(),
                reason: "Enum variants with payload fields are currently represented as unit variants in TS facades.".to_string(),
            });
        }
        variants.push(variant.ident.to_string());
    }
    ExtractEnum {
        name: item.ident.to_string(),
        type_params,
        variants,
    }
}

fn parse_trait(item: &ItemTrait, file: &str, issues: &mut Vec<SkipIssue>) -> ExtractTrait {
    let mut type_params = parse_type_params(&item.generics, file, "Trait", &item.ident.to_string(), issues);
    let mut methods = Vec::new();

    for trait_item in &item.items {
        match trait_item {
            TraitItem::Fn(method) => methods.push(parse_signature(&method.sig, file, issues)),
            TraitItem::Type(assoc_type) => {
                let assoc = assoc_type.ident.to_string();
                if !type_params.contains(&assoc) {
                    type_params.push(assoc);
                }
            }
            other => issues.push(SkipIssue {
                file: file.to_string(),
                kind: "trait".to_string(),
                snippet: other.to_token_stream().to_string(),
                reason: "Unsupported trait member kind was skipped.".to_string(),
            }),
        }
    }

    let super_traits = item
        .supertraits
        .iter()
        .map(|bound| normalize_ws(bound.to_token_stream().to_string()))
        .collect::<Vec<_>>();

    ExtractTrait {
        name: item.ident.to_string(),
        type_params,
        super_traits,
        methods,
    }
}

fn parse_impl(item: &ItemImpl, file: &str, issues: &mut Vec<SkipIssue>) -> Option<PendingMethods> {
    if item.trait_.is_some() {
        return None;
    }
    let target = match item.self_ty.as_ref() {
        Type::Path(path) => path
            .path
            .segments
            .last()
            .map(|segment| segment.ident.to_string()),
        _ => None,
    };
    let Some(target) = target else {
        issues.push(SkipIssue {
            file: file.to_string(),
            kind: "impl".to_string(),
            snippet: item.self_ty.to_token_stream().to_string(),
            reason: "Unsupported impl target (expected a nominal path type).".to_string(),
        });
        return None;
    };

    let mut methods = Vec::new();
    for impl_item in &item.items {
        if let ImplItem::Fn(m) = impl_item {
            if !is_public(&m.vis) {
                continue;
            }
            methods.push(parse_signature(&m.sig, file, issues));
        }
    }

    if methods.is_empty() {
        return None;
    }
    Some(PendingMethods { target, methods })
}

fn has_macro_export(attrs: &[syn::Attribute]) -> bool {
    attrs
        .iter()
        .any(|attr| attr.path().is_ident("macro_export"))
}

fn resolve_child_module_file(base_dir: &Path, module_name: &str) -> Result<PathBuf, String> {
    let direct = base_dir.join(format!("{module_name}.rs"));
    if direct.exists() {
        return Ok(direct);
    }
    let nested = base_dir.join(module_name).join("mod.rs");
    if nested.exists() {
        return Ok(nested);
    }
    Err(format!(
        "Could not resolve pub mod '{module_name}' from base directory {}.",
        base_dir.display()
    ))
}

fn module_base_dir_for_file(file_path: &Path) -> PathBuf {
    let parent = file_path.parent().unwrap_or_else(|| Path::new("."));
    let name = file_path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    if name == "mod.rs" || name == "lib.rs" || name == "main.rs" {
        return parent.to_path_buf();
    }
    let stem = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("module");
    parent.join(stem)
}

fn collect_module_items(
    file_label: &str,
    parts: &[String],
    base_dir: &Path,
    items: &[Item],
    out: &mut Vec<ExtractModule>,
    seen_files: &mut HashSet<PathBuf>,
) -> Result<(), String> {
    let mut module = ExtractModule {
        file: file_label.to_string(),
        parts: parts.to_vec(),
        consts: Vec::new(),
        enums: Vec::new(),
        structs: Vec::new(),
        traits: Vec::new(),
        functions: Vec::new(),
        pending_methods: Vec::new(),
        issues: Vec::new(),
    };

    for item in items {
        match item {
            Item::Mod(ItemMod { vis, ident, content, .. }) if is_public(vis) => {
                let mut child_parts = parts.to_vec();
                child_parts.push(ident.to_string());
                if let Some((_, inline_items)) = content {
                    let inline_base = base_dir.join(ident.to_string());
                    collect_module_items(
                        file_label,
                        &child_parts,
                        &inline_base,
                        inline_items,
                        out,
                        seen_files,
                    )?;
                    continue;
                }
                let child_file = resolve_child_module_file(base_dir, &ident.to_string())?;
                collect_module_file(&child_file, &child_parts, out, seen_files)?;
            }
            Item::Const(c) if is_public(&c.vis) => module.consts.push(parse_const(c)),
            Item::Fn(f) if is_public(&f.vis) => {
                module
                    .functions
                    .push(parse_signature(&f.sig, file_label, &mut module.issues));
            }
            Item::Struct(s) if is_public(&s.vis) => {
                module
                    .structs
                    .push(parse_struct(s, file_label, &mut module.issues));
            }
            Item::Enum(e) if is_public(&e.vis) => {
                module.enums.push(parse_enum(e, file_label, &mut module.issues));
            }
            Item::Trait(t) if is_public(&t.vis) => {
                module.traits.push(parse_trait(t, file_label, &mut module.issues));
            }
            Item::Impl(i) => {
                if let Some(pending) = parse_impl(i, file_label, &mut module.issues) {
                    module.pending_methods.push(pending);
                }
            }
            Item::Macro(m) if has_macro_export(&m.attrs) => {
                if let Some(name) = &m.ident {
                    module.functions.push(macro_stub(name.to_string()));
                } else {
                    module.issues.push(SkipIssue {
                        file: file_label.to_string(),
                        kind: "macro".to_string(),
                        snippet: m.to_token_stream().to_string(),
                        reason: "Encountered #[macro_export] macro_rules! without a stable name.".to_string(),
                    });
                }
            }
            _ => {}
        }
    }

    if !module.pending_methods.is_empty() {
        module
            .pending_methods
            .sort_by(|a, b| a.target.cmp(&b.target));
    }
    out.push(module);
    Ok(())
}

fn collect_module_file(
    file_path: &Path,
    parts: &[String],
    out: &mut Vec<ExtractModule>,
    seen_files: &mut HashSet<PathBuf>,
) -> Result<(), String> {
    let canonical = fs::canonicalize(file_path).map_err(|e| {
        format!(
            "Failed to canonicalize module path {}: {e}",
            file_path.display()
        )
    })?;
    if !seen_files.insert(canonical.clone()) {
        return Ok(());
    }

    let source = fs::read_to_string(&canonical)
        .map_err(|e| format!("Failed to read module file {}: {e}", canonical.display()))?;
    let file = syn::parse_file(&source)
        .map_err(|e| format!("Failed to parse Rust module {}: {e}", canonical.display()))?;
    let base_dir = module_base_dir_for_file(&canonical);
    collect_module_items(
        &canonical.to_string_lossy(),
        parts,
        &base_dir,
        &file.items,
        out,
        seen_files,
    )
}

fn extract_modules(manifest_path: &Path) -> Result<Vec<ExtractModule>, String> {
    let crate_root = manifest_path.parent().ok_or_else(|| {
        format!(
            "Manifest path has no parent directory: {}",
            manifest_path.display()
        )
    })?;
    let root_file = crate_root.join("src").join("lib.rs");
    if !root_file.exists() {
        return Err(format!(
            "Missing library root {} (expected src/lib.rs).",
            root_file.display()
        ));
    }

    let mut modules = Vec::new();
    let mut seen_files = HashSet::new();
    collect_module_file(&root_file, &[], &mut modules, &mut seen_files)?;
    modules.sort_by(|a, b| {
        let left = if a.parts.is_empty() {
            String::new()
        } else {
            a.parts.join("::")
        };
        let right = if b.parts.is_empty() {
            String::new()
        } else {
            b.parts.join("::")
        };
        left.cmp(&right).then(a.file.cmp(&b.file))
    });
    Ok(modules)
}

fn run() -> Result<(), String> {
    let mut args = env::args().skip(1);
    let Some(manifest) = args.next() else {
        return Err("Usage: tsubabindgen-extractor <manifest-path>".to_string());
    };
    if args.next().is_some() {
        return Err("Usage: tsubabindgen-extractor <manifest-path>".to_string());
    }

    let manifest_path = PathBuf::from(manifest);
    let modules = extract_modules(&manifest_path)?;
    let payload = ExtractOutput { schema: 1, modules };
    let json = serde_json::to_string(&payload)
        .map_err(|e| format!("Failed to serialize extractor output: {e}"))?;
    println!("{json}");
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
