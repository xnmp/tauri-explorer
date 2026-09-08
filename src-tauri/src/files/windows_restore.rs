//! Collision-preserving Windows Recycle Bin restores on a caller-owned STA.

use super::restore_outcome::{
    classify_completion, CompletionEvidence, ItemCompletion, RestoreOutcome,
};
use crate::error::AppError;
use std::{
    cmp::Ordering,
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
        Globalization::{CompareStringOrdinal, CSTR_EQUAL, CSTR_GREATER_THAN, CSTR_LESS_THAN},
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED,
        },
        UI::Shell::{
            FileOperation, IFileOperation, IFileOperationProgressSink,
            IFileOperationProgressSink_Impl, IShellItem, SHCreateItemFromParsingName,
            FOFX_EARLYFAILURE, FOF_NOERRORUI, FOF_NO_CONNECTED_ELEMENTS, FOF_RENAMEONCOLLISION,
            FOF_SILENT, SICHINT_CANONICAL, SIGDN_FILESYSPATH, TSF_OVERWRITE_EXIST,
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

#[implement(IFileOperationProgressSink, Agile = false)]
struct MoveSink {
    state: Arc<Mutex<SinkState>>,
    requested: PathBuf,
    source: IShellItem,
}

impl MoveSink {
    fn record(
        &self,
        callback_source: windows::core::Ref<'_, IShellItem>,
        hresult: HRESULT,
        created: windows::core::Ref<'_, IShellItem>,
    ) {
        // A directory operation may report descendants. Only the exact Shell
        // item queued by this adapter can prove completion of the root item.
        // Perform the COM comparison before taking the state lock.
        let source_match = callback_source
            .ok()
            .map_err(|error| format!("the callback source was null: {error}"))
            .and_then(|callback_source| {
                unsafe {
                    self.source
                        .Compare(callback_source, SICHINT_CANONICAL.0 as u32)
                }
                .map(|ordering| ordering == 0)
                .map_err(|error| format!("the callback source could not be compared: {error}"))
            });
        match source_match {
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
        let actual_path = created
            .ok()
            .map_err(|error| format!("the Shell returned no created item: {error}"))
            .and_then(shell_item_path);
        let requested_matches_actual = actual_path
            .as_ref()
            .is_ok_and(|actual| windows_path_eq(&self.requested, actual));
        let mut state = self
            .state
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

    fn record_invalid_source(&self, error: String) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.invalid_source.is_none() {
            state.invalid_source = Some(error);
        }
    }
}

#[allow(non_snake_case)]
impl IFileOperationProgressSink_Impl for MoveSink_Impl {
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
        if dwflags & TSF_OVERWRITE_EXIST.0 as u32 != 0 {
            self.state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .rejected_transfer_flags = Some(dwflags);
            return Err(WindowsError::from_hresult(E_ABORT));
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
        self.record(psiitem, hrmove, psinewlycreated);
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
        _dwflags: u32,
        _psiitem: windows::core::Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }

    fn PostDeleteItem(
        &self,
        _dwflags: u32,
        _psiitem: windows::core::Ref<'_, IShellItem>,
        _hrdelete: HRESULT,
        _psinewlycreated: windows::core::Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
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

/// Pre-encoded Windows path ordering key for case-insensitive native identity.
/// Only verbatim DOS-drive paths are folded onto their ordinary spelling; UNC
/// and device prefixes retain their distinct namespace semantics.
#[derive(Clone, Debug)]
pub(crate) struct WindowsPathKey(Vec<u16>);

impl WindowsPathKey {
    pub(crate) fn new(path: &Path) -> Self {
        let mut path: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .map(|unit| {
                if unit == b'/' as u16 {
                    b'\\' as u16
                } else {
                    unit
                }
            })
            .collect();
        const VERBATIM: [u16; 4] = [b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
        let verbatim_dos_drive = path.starts_with(&VERBATIM)
            && path.get(4).is_some_and(|unit| {
                (*unit >= b'A' as u16 && *unit <= b'Z' as u16)
                    || (*unit >= b'a' as u16 && *unit <= b'z' as u16)
            })
            && path.get(5) == Some(&(b':' as u16))
            && path.get(6) == Some(&(b'\\' as u16));
        if verbatim_dos_drive {
            path.drain(..VERBATIM.len());
        }
        Self(path)
    }

    pub(crate) fn compare(&self, other: &Self) -> Result<Ordering, AppError> {
        match unsafe { CompareStringOrdinal(&self.0, &other.0, true) } {
            result if result == CSTR_LESS_THAN => Ok(Ordering::Less),
            result if result == CSTR_EQUAL => Ok(Ordering::Equal),
            result if result == CSTR_GREATER_THAN => Ok(Ordering::Greater),
            _ => Err(AppError::Other(
                "Windows could not compare native path identities".into(),
            )),
        }
    }
}

fn windows_path_eq(left: &Path, right: &Path) -> bool {
    WindowsPathKey::new(left)
        .compare(&WindowsPathKey::new(right))
        .is_ok_and(|ordering| ordering == Ordering::Equal)
}

fn shell_item_path(item: &IShellItem) -> Result<PathBuf, String> {
    let display = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) }
        .map_err(|error| format!("the Shell did not provide a filesystem path: {error}"))?;
    let path = unsafe { OsString::from_wide(display.as_wide()) };
    unsafe { CoTaskMemFree(Some(display.as_ptr().cast::<c_void>())) };
    Ok(PathBuf::from(path))
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
    let sink: IFileOperationProgressSink = MoveSink {
        state: Arc::clone(&state),
        requested: requested.clone(),
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

#[cfg(test)]
pub(crate) fn restore_item_before_perform(
    apartment: &StaApartment,
    item: trash::TrashItem,
    before_perform: impl FnOnce(&Path) -> Result<(), AppError>,
) -> Result<(), AppError> {
    restore_item_inner(apartment, item, before_perform)
}
