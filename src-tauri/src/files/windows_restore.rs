//! Collision-preserving Windows Recycle Bin restores on a caller-owned STA.

use super::restore_outcome::{
    classify_completion, CompletionEvidence, ItemCompletion, RestoreOutcome,
};
use super::trash_artifact::{RestoreRequest, TrashArtifact, TrashSuccess};
use super::trash_outcome::{
    classify_delete, DeleteCompletionEvidence, DeleteItemCompletion, DeleteOutcome, DeletedArtifact,
};
pub(crate) use super::windows_paths::WindowsPathKey;
use crate::error::AppError;
use std::{
    ffi::{c_void, OsStr, OsString},
    marker::PhantomData,
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
    rc::Rc,
    sync::{Arc, Mutex},
};
use windows::{
    core::{implement, Error as WindowsError, HRESULT, PCWSTR},
    Win32::{
        Foundation::E_ABORT,
        Globalization::{CompareStringOrdinal, CSTR_EQUAL},
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED,
        },
        UI::Shell::{
            FileOperation, IFileOperation, IFileOperationProgressSink,
            IFileOperationProgressSink_Impl, IShellItem, SHCreateItemFromParsingName,
            FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE, FOF_NOERRORUI, FOF_NO_CONNECTED_ELEMENTS,
            FOF_RENAMEONCOLLISION, FOF_SILENT, FOF_WANTNUKEWARNING, SICHINT_CANONICAL,
            SIGDN_DESKTOPABSOLUTEPARSING, SIGDN_FILESYSPATH, TSF_DELETE_RECYCLE_IF_POSSIBLE,
            TSF_OVERWRITE_EXIST,
        },
    },
};

/// Balances COM initialization on the same thread and cannot cross threads.
pub(crate) struct StaApartment {
    _not_send: PhantomData<Rc<()>>,
}

impl StaApartment {
    pub(crate) fn new() -> Result<Self, AppError> {
        let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        initialized.ok().map_err(|error| {
            AppError::Other(format!(
                "Could not initialize the Windows Shell apartment: {error}"
            ))
        })?;
        Ok(Self {
            _not_send: PhantomData,
        })
    }
}

impl Drop for StaApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

#[derive(Debug)]
struct MoveCallback {
    hresult: i32,
    actual_path: Result<PathBuf, String>,
    requested_matches_actual: bool,
}

#[derive(Debug, Default)]
struct SinkState {
    count: usize,
    first: Option<MoveCallback>,
    invalid_source: Option<String>,
    rejected_transfer_flags: Option<u32>,
}

#[derive(Debug)]
struct DeleteCallback {
    hresult: i32,
    artifact: DeletedArtifact,
}

#[derive(Debug, Default)]
struct DeleteSinkState {
    count: usize,
    first: Option<DeleteCallback>,
    invalid_source: Option<String>,
    rejected_transfer_flags: Option<u32>,
}

enum SinkMode {
    Move {
        state: Arc<Mutex<SinkState>>,
        requested: PathBuf,
        requested_parent: IShellItem,
        requested_name: OsString,
    },
    Delete {
        state: Arc<Mutex<DeleteSinkState>>,
    },
}

#[implement(IFileOperationProgressSink, Agile = false)]
struct ShellSink {
    mode: SinkMode,
    source: IShellItem,
}

impl ShellSink {
    fn source_matches(
        &self,
        callback_source: windows::core::Ref<'_, IShellItem>,
    ) -> Result<bool, String> {
        callback_source
            .ok()
            .map_err(|error| format!("the callback source was null: {error}"))
            .and_then(|callback_source| {
                unsafe {
                    self.source
                        .Compare(callback_source, SICHINT_CANONICAL.0 as u32)
                }
                .map(|ordering| ordering == 0)
                .map_err(|error| format!("the callback source could not be compared: {error}"))
            })
    }

    fn record_move(
        &self,
        callback_source: windows::core::Ref<'_, IShellItem>,
        hresult: HRESULT,
        created: windows::core::Ref<'_, IShellItem>,
    ) {
        // A directory operation may report descendants. Only the exact Shell
        // item queued by this adapter can prove completion of the root item.
        // Perform the COM comparison before taking the state lock.
        match self.source_matches(callback_source) {
            Ok(true) => {}
            Ok(false) => {
                self.record_invalid_source("the callback described a different Shell item".into());
                return;
            }
            Err(error) => {
                self.record_invalid_source(error);
                return;
            }
        }
        let SinkMode::Move {
            state,
            requested,
            requested_parent,
            requested_name,
        } = &self.mode
        else {
            return;
        };
        let (actual_path, requested_matches_actual) = match created.ok() {
            Ok(created) => {
                let actual_path = shell_item_path(created);
                let parent_matches = shell_item_parent_matches(created, requested_parent);
                let path_matches = actual_path
                    .as_ref()
                    .is_ok_and(|actual| windows_path_eq(requested, actual));
                let leaf_matches = actual_path.as_ref().is_ok_and(|actual| {
                    actual
                        .file_name()
                        .is_some_and(|actual_name| windows_leaf_eq(requested_name, actual_name))
                });
                (
                    actual_path,
                    path_matches || (parent_matches.is_ok_and(|matches| matches) && leaf_matches),
                )
            }
            Err(error) => (
                Err(format!("the Shell returned no created item: {error}")),
                false,
            ),
        };
        let mut state = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.count = state.count.saturating_add(1);
        if state.first.is_none() {
            state.first = Some(MoveCallback {
                hresult: hresult.0,
                actual_path,
                requested_matches_actual,
            });
        }
    }

    fn pre_delete(
        &self,
        flags: u32,
        callback_source: windows::core::Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        let SinkMode::Delete { state } = &self.mode else {
            return Ok(());
        };
        match self.source_matches(callback_source) {
            Ok(true) => {}
            Ok(false) => {
                self.record_invalid_source("the callback described a different Shell item".into());
                return Ok(());
            }
            Err(error) => {
                self.record_invalid_source(error);
                return Ok(());
            }
        }
        if flags & TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32 == 0 {
            state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .rejected_transfer_flags = Some(flags);
            return Err(WindowsError::from_hresult(E_ABORT));
        }
        Ok(())
    }

    fn record_delete(
        &self,
        callback_source: windows::core::Ref<'_, IShellItem>,
        hresult: HRESULT,
        created: windows::core::Ref<'_, IShellItem>,
    ) {
        match self.source_matches(callback_source) {
            Ok(true) => {}
            Ok(false) => {
                self.record_invalid_source("the callback described a different Shell item".into());
                return;
            }
            Err(error) => {
                self.record_invalid_source(error);
                return;
            }
        }
        let artifact = created
            .as_ref()
            .map_or(DeletedArtifact::Missing, |created| {
                shell_item_parsing_name(created)
                    .map(DeletedArtifact::ParsingName)
                    .unwrap_or_else(DeletedArtifact::Unavailable)
            });
        let SinkMode::Delete { state } = &self.mode else {
            return;
        };
        let mut state = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.count = state.count.saturating_add(1);
        if state.first.is_none() {
            state.first = Some(DeleteCallback {
                hresult: hresult.0,
                artifact,
            });
        }
    }

    fn record_invalid_source(&self, error: String) {
        match &self.mode {
            SinkMode::Move { state, .. } => {
                let mut state = state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if state.invalid_source.is_none() {
                    state.invalid_source = Some(error);
                }
            }
            SinkMode::Delete { state } => {
                let mut state = state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if state.invalid_source.is_none() {
                    state.invalid_source = Some(error);
                }
            }
        }
    }
}

#[allow(non_snake_case)]
impl IFileOperationProgressSink_Impl for ShellSink_Impl {
    fn StartOperations(&self) -> windows::core::Result<()> {
        Ok(())
    }

    fn FinishOperations(&self, _hrresult: HRESULT) -> windows::core::Result<()> {
        Ok(())
    }

    fn PreRenameItem(
        &self,
        _dwflags: u32,
        _psiitem: windows::core::Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
    ) -> windows::core::Result<()> {
        Ok(())
    }

    fn PostRenameItem(
        &self,
        _dwflags: u32,
        _psiitem: windows::core::Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
        _hrrename: HRESULT,
        _psinewlycreated: windows::core::Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }

    fn PreMoveItem(
        &self,
        dwflags: u32,
        _psiitem: windows::core::Ref<'_, IShellItem>,
        _psidestinationfolder: windows::core::Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
    ) -> windows::core::Result<()> {
        if let SinkMode::Move { state, .. } = &self.mode {
            if dwflags & TSF_OVERWRITE_EXIST.0 as u32 != 0 {
                state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .rejected_transfer_flags = Some(dwflags);
                return Err(WindowsError::from_hresult(E_ABORT));
            }
        }
        Ok(())
    }

    fn PostMoveItem(
        &self,
        _dwflags: u32,
        psiitem: windows::core::Ref<'_, IShellItem>,
        _psidestinationfolder: windows::core::Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
        hrmove: HRESULT,
        psinewlycreated: windows::core::Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        if matches!(&self.mode, SinkMode::Move { .. }) {
            self.record_move(psiitem, hrmove, psinewlycreated);
        }
        Ok(())
    }

    fn PreCopyItem(
        &self,
        _dwflags: u32,
        _psiitem: windows::core::Ref<'_, IShellItem>,
        _psidestinationfolder: windows::core::Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
    ) -> windows::core::Result<()> {
        Ok(())
    }

    fn PostCopyItem(
        &self,
        _dwflags: u32,
        _psiitem: windows::core::Ref<'_, IShellItem>,
        _psidestinationfolder: windows::core::Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
        _hrcopy: HRESULT,
        _psinewlycreated: windows::core::Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }

    fn PreDeleteItem(
        &self,
        dwflags: u32,
        psiitem: windows::core::Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        self.pre_delete(dwflags, psiitem)
    }

    fn PostDeleteItem(
        &self,
        _dwflags: u32,
        psiitem: windows::core::Ref<'_, IShellItem>,
        hrdelete: HRESULT,
        psinewlycreated: windows::core::Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        if matches!(&self.mode, SinkMode::Delete { .. }) {
            self.record_delete(psiitem, hrdelete, psinewlycreated);
        }
        Ok(())
    }

    fn PreNewItem(
        &self,
        _dwflags: u32,
        _psidestinationfolder: windows::core::Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
    ) -> windows::core::Result<()> {
        Ok(())
    }

    fn PostNewItem(
        &self,
        _dwflags: u32,
        _psidestinationfolder: windows::core::Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
        _psztemplatename: &PCWSTR,
        _dwfileattributes: u32,
        _hrnew: HRESULT,
        _psinewitem: windows::core::Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }

    fn UpdateProgress(&self, _iworktotal: u32, _iworksofar: u32) -> windows::core::Result<()> {
        Ok(())
    }

    fn ResetTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }

    fn PauseTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }

    fn ResumeTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
}

fn to_wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

pub(crate) fn shell_filesystem_name(path: &Path) -> Vec<u16> {
    // The app accepts ordinary Windows paths with either separator, but the
    // Shell parsing API requires native spelling. Rebuild components so their
    // separators are native without altering verbatim component contents.
    let native: PathBuf = path.components().collect();
    let mut name: Vec<u16> = native.as_os_str().encode_wide().collect();
    const VERBATIM: [u16; 4] = [b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    let verbatim_dos_drive = name.starts_with(&VERBATIM)
        && name.get(4).is_some_and(|unit| {
            (*unit >= b'A' as u16 && *unit <= b'Z' as u16)
                || (*unit >= b'a' as u16 && *unit <= b'z' as u16)
        })
        && name.get(5) == Some(&(b':' as u16))
        && name.get(6) == Some(&(b'\\' as u16));
    if verbatim_dos_drive {
        name.drain(..VERBATIM.len());
    }
    name.push(0);
    name
}

fn windows_path_eq(left: &Path, right: &Path) -> bool {
    WindowsPathKey::new(left)
        .compare(&WindowsPathKey::new(right))
        .is_ok_and(|ordering| ordering.is_eq())
}

pub(super) fn windows_leaf_eq(left: &OsStr, right: &OsStr) -> bool {
    let left: Vec<u16> = left.encode_wide().collect();
    let right: Vec<u16> = right.encode_wide().collect();
    (unsafe { CompareStringOrdinal(&left, &right, true) }) == CSTR_EQUAL
}

fn shell_item_path(item: &IShellItem) -> Result<PathBuf, String> {
    let display = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) }
        .map_err(|error| format!("the Shell did not provide a filesystem path: {error}"))?;
    let path = unsafe { OsString::from_wide(display.as_wide()) };
    unsafe { CoTaskMemFree(Some(display.as_ptr().cast::<c_void>())) };
    Ok(PathBuf::from(path))
}

fn shell_item_parent_matches(item: &IShellItem, expected: &IShellItem) -> Result<bool, String> {
    let actual = unsafe { item.GetParent() }
        .map_err(|error| format!("the created item's parent was unavailable: {error}"))?;
    unsafe { expected.Compare(&actual, SICHINT_CANONICAL.0 as u32) }
        .map(|ordering| ordering == 0)
        .map_err(|error| format!("the created item's parent could not be compared: {error}"))
}

fn shell_item_parsing_name(item: &IShellItem) -> Result<Vec<u16>, String> {
    let display = unsafe { item.GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING) }
        .map_err(|error| format!("the Shell did not provide an absolute parsing name: {error}"))?;
    let name = unsafe { display.as_wide().to_vec() };
    unsafe { CoTaskMemFree(Some(display.as_ptr().cast::<c_void>())) };
    if name.is_empty() {
        return Err("the Shell returned an empty absolute parsing name".into());
    }
    Ok(name)
}

fn windows_error(context: &str, error: WindowsError) -> AppError {
    AppError::Other(format!("{context}: {error}"))
}

fn callback_evidence(state: &Arc<Mutex<SinkState>>) -> ItemCompletion {
    let mut state = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match state.count {
        0 => state
            .invalid_source
            .take()
            .map_or(ItemCompletion::Missing, ItemCompletion::InvalidSource),
        1 => match state.first.take() {
            Some(callback) => ItemCompletion::One {
                hresult: callback.hresult,
                actual_path: callback.actual_path,
                requested_matches_actual: callback.requested_matches_actual,
            },
            None => ItemCompletion::Missing,
        },
        _ => ItemCompletion::Duplicate,
    }
}

fn delete_callback_evidence(state: &Arc<Mutex<DeleteSinkState>>) -> (DeleteItemCompletion, bool) {
    let mut state = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let other_activity = state.invalid_source.is_some();
    let item = match state.count {
        0 => state.invalid_source.take().map_or(
            DeleteItemCompletion::Missing,
            DeleteItemCompletion::InvalidSource,
        ),
        1 => match state.first.take() {
            Some(callback) => DeleteItemCompletion::One {
                hresult: callback.hresult,
                artifact: callback.artifact,
            },
            None => DeleteItemCompletion::Missing,
        },
        _ => DeleteItemCompletion::Duplicate,
    };
    (item, other_activity)
}

fn restore_item_inner(
    _apartment: &StaApartment,
    item: trash::TrashItem,
    before_perform: impl FnOnce(&Path) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let requested = item.original_path();
    let source_name = to_wide(&item.id);
    let parent_name = to_wide(item.original_parent.as_os_str());
    let restored_name = to_wide(&item.name);

    let operation: IFileOperation = unsafe {
        CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| windows_error("Could not create the Windows trash restore", error))?
    };
    // RENAMEONCOLLISION applies to files and folders. It prevents replacement
    // and directory merging by assigning the restored item an alternate name.
    // ACL and copy-hook flags are intentionally left to normal Shell policy.
    let flags = FOF_SILENT
        | FOF_NOERRORUI
        | FOF_NO_CONNECTED_ELEMENTS
        | FOF_RENAMEONCOLLISION
        | FOFX_EARLYFAILURE;
    unsafe { operation.SetOperationFlags(flags) }
        .map_err(|error| windows_error("Could not configure the Windows trash restore", error))?;
    let source: IShellItem =
        unsafe { SHCreateItemFromParsingName(PCWSTR(source_name.as_ptr()), None) }
            .map_err(|error| windows_error("Could not open the Recycle Bin item", error))?;
    let parent: IShellItem =
        unsafe { SHCreateItemFromParsingName(PCWSTR(parent_name.as_ptr()), None) }.map_err(
            |error| windows_error("Could not open the original parent directory", error),
        )?;

    let state = Arc::new(Mutex::new(SinkState::default()));
    let sink: IFileOperationProgressSink = ShellSink {
        mode: SinkMode::Move {
            state: Arc::clone(&state),
            requested: requested.clone(),
            requested_parent: parent.clone(),
            requested_name: item.name.clone(),
        },
        source: source.clone(),
    }
    .into();
    unsafe { operation.MoveItem(&source, &parent, PCWSTR(restored_name.as_ptr()), &sink) }
        .map_err(|error| windows_error("Could not queue the Windows trash restore", error))?;

    before_perform(&requested)?;

    // From this point onward only the per-item callback can prove the effect.
    let perform_error = unsafe { operation.PerformOperations() }
        .err()
        .map(|error| error.to_string());
    // Microsoft requires this query even when PerformOperations returns an
    // error, since cancellation can otherwise be reported as success.
    let aborted = unsafe { operation.GetAnyOperationsAborted() }
        .map(|aborted| aborted.as_bool())
        .map_err(|error| error.to_string());
    let evidence = CompletionEvidence {
        item: callback_evidence(&state),
        rejected_transfer_flags: state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .rejected_transfer_flags,
        perform_error,
        aborted,
    };
    match classify_completion(evidence) {
        RestoreOutcome::Exact => Ok(()),
        RestoreOutcome::Uncertain(detail) => Err(AppError::MutationUncertain(detail)),
    }
}

pub(crate) fn restore_item(
    apartment: &StaApartment,
    item: trash::TrashItem,
) -> Result<(), AppError> {
    restore_item_inner(apartment, item, |_| Ok(()))
}

/// Restore the exact Shell item captured by the corresponding delete callback.
/// No Recycle Bin inventory lookup or same-path heuristic is involved.
pub(crate) fn restore_exact(
    apartment: &StaApartment,
    request: &RestoreRequest,
) -> Result<(), AppError> {
    let TrashArtifact::WindowsShell { parsing_name_utf16 } = request.artifact.as_ref() else {
        return Err(AppError::InvalidPath(
            "Trash history item does not contain a Windows Shell identity".into(),
        ));
    };
    if parsing_name_utf16.is_empty() || parsing_name_utf16.contains(&0) {
        return Err(AppError::InvalidPath(
            "Invalid Windows Recycle Bin identity".into(),
        ));
    }
    let path = Path::new(&request.path);
    let original_parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| AppError::InvalidPath(format!("Invalid restore path: {}", request.path)))?;
    let name = path
        .file_name()
        .ok_or_else(|| AppError::InvalidPath(format!("Invalid restore path: {}", request.path)))?;
    let item = trash::TrashItem {
        id: OsString::from_wide(parsing_name_utf16),
        name: name.to_os_string(),
        original_parent: original_parent.to_path_buf(),
        time_deleted: 0,
    };
    restore_item(apartment, item)
}

/// Delete one exact source through the Shell and capture its exact Recycle Bin
/// identity. The caller owns the STA and must keep all COM work on its thread.
pub(crate) fn delete_item(
    _apartment: &StaApartment,
    source_path: &Path,
) -> Result<TrashSuccess, AppError> {
    let operation: IFileOperation = unsafe {
        CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| windows_error("Could not create the Windows trash operation", error))?
    };
    let flags = FOF_SILENT
        | FOF_NOERRORUI
        | FOF_NO_CONNECTED_ELEMENTS
        | FOF_WANTNUKEWARNING
        | FOFX_EARLYFAILURE
        | FOFX_RECYCLEONDELETE;
    unsafe { operation.SetOperationFlags(flags) }
        .map_err(|error| windows_error("Could not configure the Windows trash operation", error))?;

    let source_name = shell_filesystem_name(source_path);
    let source: IShellItem =
        unsafe { SHCreateItemFromParsingName(PCWSTR(source_name.as_ptr()), None) }
            .map_err(|error| windows_error("Could not open the item to recycle", error))?;
    let state = Arc::new(Mutex::new(DeleteSinkState::default()));
    let sink: IFileOperationProgressSink = ShellSink {
        mode: SinkMode::Delete {
            state: Arc::clone(&state),
        },
        source: source.clone(),
    }
    .into();
    unsafe { operation.DeleteItem(&source, &sink) }
        .map_err(|error| windows_error("Could not queue the Windows trash operation", error))?;

    // From this point onward only source-verified callback evidence can settle
    // the effect; probing the original path would introduce a TOCTOU alias.
    let perform_error = unsafe { operation.PerformOperations() }
        .err()
        .map(|error| error.to_string());
    let aborted = unsafe { operation.GetAnyOperationsAborted() }
        .map(|aborted| aborted.as_bool())
        .map_err(|error| error.to_string());
    let (item, other_activity) = delete_callback_evidence(&state);
    let evidence = DeleteCompletionEvidence {
        item,
        other_activity,
        rejected_transfer_flags: state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .rejected_transfer_flags,
        perform_error,
        aborted,
    };
    match classify_delete(evidence) {
        DeleteOutcome::Recycled(parsing_name_utf16) => Ok(TrashSuccess {
            publication: None,
            artifact: Some(Arc::new(TrashArtifact::WindowsShell { parsing_name_utf16 })),
            warning: None,
        }),
        DeleteOutcome::CommittedWithoutArtifact(warning) => Ok(TrashSuccess {
            publication: None,
            artifact: None,
            warning: Some(warning),
        }),
        DeleteOutcome::Unchanged(error) => Err(AppError::Other(error)),
        DeleteOutcome::Uncertain(error) => Err(AppError::MutationUncertain(error)),
    }
}

#[cfg(test)]
pub(crate) fn restore_item_before_perform(
    apartment: &StaApartment,
    item: trash::TrashItem,
    before_perform: impl FnOnce(&Path) -> Result<(), AppError>,
) -> Result<(), AppError> {
    restore_item_inner(apartment, item, before_perform)
}
