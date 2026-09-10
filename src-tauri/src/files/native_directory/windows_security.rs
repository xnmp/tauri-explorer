//! Exact security policy for recovery directories and their contents.

use std::{
    ffi::c_void,
    fs::File,
    io,
    mem::{offset_of, size_of},
    os::windows::io::AsRawHandle,
    ptr,
};

use windows::Win32::{
    Foundation::{
        CloseHandle, LocalFree, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, HANDLE, HLOCAL,
    },
    Security::{
        AclSizeInformation, AddAccessAllowedAceEx,
        Authorization::{GetSecurityInfo, SE_FILE_OBJECT},
        CopySid, CreateWellKnownSid, GetAce, GetAclInformation, GetLengthSid,
        GetSecurityDescriptorControl, GetSecurityDescriptorDacl, GetSecurityDescriptorOwner,
        GetTokenInformation, InitializeAcl, InitializeSecurityDescriptor, IsValidAcl,
        IsValidSecurityDescriptor, IsValidSid, SetSecurityDescriptorControl,
        SetSecurityDescriptorDacl, SetSecurityDescriptorOwner, TokenUser, WinLocalSystemSid,
        ACCESS_ALLOWED_ACE, ACE_FLAGS, ACE_HEADER, ACL, ACL_REVISION, ACL_SIZE_INFORMATION,
        CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, INHERITED_ACE, OBJECT_INHERIT_ACE,
        OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_DESCRIPTOR,
        SECURITY_DESCRIPTOR_CONTROL, SE_DACL_DEFAULTED, SE_DACL_PRESENT, SE_DACL_PROTECTED,
        TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::FILE_ALL_ACCESS,
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

use super::super::windows_io::io_error;

// These SDK constants are generated behind Win32_System_SystemServices even
// though the APIs consuming them are part of Win32_Security.
const SECURITY_DESCRIPTOR_REVISION: u32 = 1;
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const SID_MINIMUM_BYTES: usize = 8;
const PRIVATE_ACE_FLAGS: u8 = (OBJECT_INHERIT_ACE.0 | CONTAINER_INHERIT_ACE.0) as u8;

/// An absolute descriptor. The backing SID and ACL allocations must outlive
/// every native create call that receives `as_ptr()`.
pub(super) struct PrivateDescriptor {
    descriptor: Box<SECURITY_DESCRIPTOR>,
    _owner_sid: AlignedBuffer,
    _system_sid: AlignedBuffer,
    _dacl: AlignedBuffer,
}

impl PrivateDescriptor {
    pub(super) fn new() -> io::Result<Self> {
        let owner_sid = current_user_sid()?;
        let system_sid = well_known_system_sid()?;
        let mut dacl = private_dacl(owner_sid.sid(), system_sid.sid())?;
        let mut descriptor = Box::new(SECURITY_DESCRIPTOR::default());
        let descriptor_ptr = PSECURITY_DESCRIPTOR(descriptor.as_mut() as *mut _ as *mut c_void);

        // SAFETY: all pointers refer to writable, aligned allocations owned by
        // the returned value. Setters only store SID/ACL pointers; the fields
        // retaining those allocations are not moved internally afterwards.
        unsafe {
            InitializeSecurityDescriptor(descriptor_ptr, SECURITY_DESCRIPTOR_REVISION)
                .map_err(io_error)?;
            SetSecurityDescriptorOwner(descriptor_ptr, Some(owner_sid.sid()), false)
                .map_err(io_error)?;
            SetSecurityDescriptorDacl(descriptor_ptr, true, Some(dacl.acl()), false)
                .map_err(io_error)?;
            SetSecurityDescriptorControl(descriptor_ptr, SE_DACL_PROTECTED, SE_DACL_PROTECTED)
                .map_err(io_error)?;
        }

        let result = Self {
            descriptor,
            _owner_sid: owner_sid,
            _system_sid: system_sid,
            _dacl: dacl,
        };
        validate_descriptor(result.descriptor_ptr(), AcePolicy::ExplicitDirectory)?;
        Ok(result)
    }

    pub(super) fn as_ptr(&self) -> *mut c_void {
        self.descriptor_ptr().0
    }

    fn descriptor_ptr(&self) -> PSECURITY_DESCRIPTOR {
        PSECURITY_DESCRIPTOR(self.descriptor.as_ref() as *const _ as *mut c_void)
    }
}

/// Verifies security through the retained object handle, independent of the
/// path currently naming that object.
pub(crate) fn validate_private(file: &File) -> io::Result<()> {
    let policy = if file.metadata()?.is_dir() {
        AcePolicy::ExplicitDirectory
    } else {
        AcePolicy::ExplicitFile
    };
    validate_file_descriptor(file, policy)
}

/// Validates an ordinary file that inherited its confinement from an already
/// handle-validated private parent. This validates the child's effective ACL;
/// the caller must retain and validate the parent separately as its authority.
pub(super) fn validate_inherited_file(file: &File) -> io::Result<()> {
    if !file.metadata()?.is_file() {
        return Err(invalid_security(
            "inherited-file security validation requires a regular file",
        ));
    }
    validate_file_descriptor(file, AcePolicy::InheritedFile)
}

fn validate_file_descriptor(file: &File, policy: AcePolicy) -> io::Result<()> {
    let handle = HANDLE(file.as_raw_handle());
    let mut descriptor = PSECURITY_DESCRIPTOR::default();

    // SAFETY: `handle` remains owned by `file`; GetSecurityInfo allocates the
    // returned descriptor with LocalAlloc for this caller to release.
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            None,
            None,
            None,
            None,
            Some(&mut descriptor),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status.0 as i32));
    }
    if descriptor.0.is_null() {
        return Err(invalid_security(
            "Windows returned a null security descriptor",
        ));
    }

    let descriptor = LocalDescriptor(descriptor);
    validate_descriptor(descriptor.0, policy)
}

fn validate_descriptor(descriptor: PSECURITY_DESCRIPTOR, ace_policy: AcePolicy) -> io::Result<()> {
    // SAFETY: callers provide either a live owned descriptor or the live
    // LocalAlloc result from GetSecurityInfo.
    if !unsafe { IsValidSecurityDescriptor(descriptor) }.as_bool() {
        return Err(invalid_security("invalid Windows security descriptor"));
    }

    let mut control = 0u16;
    let mut revision = 0u32;
    // SAFETY: output pointers are valid and the descriptor was validated.
    unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) }
        .map_err(io_error)?;
    let control = SECURITY_DESCRIPTOR_CONTROL(control);
    if revision != SECURITY_DESCRIPTOR_REVISION
        || !control.contains(SE_DACL_PRESENT)
        || control.contains(SE_DACL_DEFAULTED)
        || (ace_policy.is_explicit() && !control.contains(SE_DACL_PROTECTED))
    {
        return Err(invalid_security(
            "Windows security descriptor does not have a protected explicit DACL",
        ));
    }

    let expected_owner = current_user_sid()?;
    let expected_system = well_known_system_sid()?;
    validate_owner(descriptor, expected_owner.sid())?;
    validate_dacl(
        descriptor,
        expected_owner.sid(),
        expected_system.sid(),
        ace_policy,
    )
}

fn validate_owner(descriptor: PSECURITY_DESCRIPTOR, expected: PSID) -> io::Result<()> {
    let mut owner = PSID::default();
    let mut defaulted = windows::core::BOOL::default();
    // SAFETY: output pointers are valid and the descriptor was validated.
    unsafe { GetSecurityDescriptorOwner(descriptor, &mut owner, &mut defaulted) }
        .map_err(io_error)?;
    if owner.0.is_null()
        || defaulted.as_bool()
        || !unsafe { IsValidSid(owner) }.as_bool()
        || !sid_equal(owner, expected)
    {
        return Err(invalid_security(
            "Windows security descriptor is not owned by the current user",
        ));
    }
    Ok(())
}

fn validate_dacl(
    descriptor: PSECURITY_DESCRIPTOR,
    expected_owner: PSID,
    expected_system: PSID,
    ace_policy: AcePolicy,
) -> io::Result<()> {
    let mut present = windows::core::BOOL::default();
    let mut defaulted = windows::core::BOOL::default();
    let mut dacl = ptr::null_mut();
    // SAFETY: output pointers are valid and the descriptor was validated.
    unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) }
        .map_err(io_error)?;
    if !present.as_bool()
        || defaulted.as_bool()
        || dacl.is_null()
        || !unsafe { IsValidAcl(dacl) }.as_bool()
    {
        return Err(invalid_security(
            "Windows security descriptor has no valid explicit DACL",
        ));
    }

    let mut information = ACL_SIZE_INFORMATION::default();
    // SAFETY: the DACL was validated and the output structure has its exact
    // Windows layout and size.
    unsafe {
        GetAclInformation(
            dacl,
            &mut information as *mut _ as *mut c_void,
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    }
    .map_err(io_error)?;
    let owner_is_system = sid_equal(expected_owner, expected_system);
    let expected_count = if owner_is_system { 1 } else { 2 };
    if information.AceCount != expected_count {
        return Err(invalid_security(
            "Windows recovery DACL has an unexpected number of access entries",
        ));
    }

    let mut owner_seen = false;
    let mut system_seen = false;
    for index in 0..information.AceCount {
        let mut raw_ace = ptr::null_mut();
        // SAFETY: the DACL is valid and index is below the reported ACE count.
        unsafe { GetAce(dacl, index, &mut raw_ace) }.map_err(io_error)?;
        let (ace, sid) = checked_allowed_ace(raw_ace)?;
        if ace.Mask != FILE_ALL_ACCESS.0 || !ace_policy.accepts(ace.Header.AceFlags) {
            return Err(invalid_security(
                "Windows recovery DACL contains a non-private access entry",
            ));
        }

        if sid_equal(sid, expected_owner) {
            if owner_seen {
                return Err(invalid_security(
                    "Windows recovery DACL duplicates the current-user entry",
                ));
            }
            owner_seen = true;
        } else if sid_equal(sid, expected_system) {
            if system_seen {
                return Err(invalid_security(
                    "Windows recovery DACL duplicates the SYSTEM entry",
                ));
            }
            system_seen = true;
        } else {
            return Err(invalid_security(
                "Windows recovery DACL grants access to an unexpected principal",
            ));
        }
    }

    if !owner_seen || (!owner_is_system && !system_seen) {
        return Err(invalid_security(
            "Windows recovery DACL is missing a required access entry",
        ));
    }
    Ok(())
}

fn checked_allowed_ace(raw: *mut c_void) -> io::Result<(ACCESS_ALLOWED_ACE, PSID)> {
    if raw.is_null() {
        return Err(invalid_security("Windows returned a null access entry"));
    }
    // SAFETY: GetAce returned this pointer from an IsValidAcl-validated ACL.
    let header = unsafe { &*(raw as *const ACE_HEADER) };
    let sid_offset = offset_of!(ACCESS_ALLOWED_ACE, SidStart);
    if header.AceType != ACCESS_ALLOWED_ACE_TYPE
        || usize::from(header.AceSize) < sid_offset + SID_MINIMUM_BYTES
    {
        return Err(invalid_security(
            "Windows recovery DACL contains an unsupported access entry",
        ));
    }

    // SAFETY: the size check covers every fixed field through SidStart, and
    // IsValidAcl validated that the complete ACE lies inside its ACL.
    let ace = unsafe { *(raw as *const ACCESS_ALLOWED_ACE) };
    let sid = PSID(unsafe { (raw as *mut u8).add(sid_offset) }.cast());
    // A SID is an 8-byte header followed by SubAuthorityCount u32 values. Read
    // only the already-bounded header before asking Windows to validate it.
    let sid_header = unsafe { std::slice::from_raw_parts(sid.0.cast::<u8>(), SID_MINIMUM_BYTES) };
    let sid_size = SID_MINIMUM_BYTES
        .checked_add(usize::from(sid_header[1]).saturating_mul(size_of::<u32>()))
        .ok_or_else(|| invalid_security("Windows recovery DACL principal is too large"))?;
    if sid_offset
        .checked_add(sid_size)
        .is_none_or(|end| end > usize::from(header.AceSize))
        || !unsafe { IsValidSid(sid) }.as_bool()
        || unsafe { GetLengthSid(sid) } as usize != sid_size
    {
        return Err(invalid_security(
            "Windows recovery DACL contains an invalid principal",
        ));
    }
    Ok((ace, sid))
}

fn current_user_sid() -> io::Result<AlignedBuffer> {
    let mut token = HANDLE::default();
    // SAFETY: output points to a valid HANDLE and the pseudo process handle is
    // valid for the duration of this call.
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }.map_err(io_error)?;
    let token = OwnedHandle(token);

    let mut required = 0u32;
    // SAFETY: this is the documented sizing call; no output buffer is supplied.
    let sizing = unsafe { GetTokenInformation(token.0, TokenUser, None, 0, &mut required) };
    match sizing {
        Err(error) => {
            let error = io_error(error);
            if error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER.0 as i32) {
                return Err(error);
            }
        }
        Ok(()) if required == 0 => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Windows returned an empty token-user record",
            ));
        }
        Ok(()) => {}
    }
    if required == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Windows did not size the token-user record",
        ));
    }

    let mut token_user = AlignedBuffer::new(required as usize)?;
    // SAFETY: the aligned buffer has the exact size Windows requested.
    unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            Some(token_user.as_mut_ptr()),
            required,
            &mut required,
        )
    }
    .map_err(io_error)?;
    let user = unsafe { &*(token_user.as_ptr() as *const TOKEN_USER) };
    copy_sid(user.User.Sid)
}

fn well_known_system_sid() -> io::Result<AlignedBuffer> {
    let mut required = 0u32;
    // SAFETY: this is the documented sizing call with a null output SID.
    let sizing = unsafe { CreateWellKnownSid(WinLocalSystemSid, None, None, &mut required) };
    if let Err(error) = sizing {
        let error = io_error(error);
        if error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER.0 as i32) {
            return Err(error);
        }
    }
    if required == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Windows did not size the SYSTEM principal",
        ));
    }

    let mut sid = AlignedBuffer::new(required as usize)?;
    // SAFETY: the aligned buffer has the exact size Windows requested.
    unsafe { CreateWellKnownSid(WinLocalSystemSid, None, Some(sid.sid_mut()), &mut required) }
        .map_err(io_error)?;
    Ok(sid)
}

fn copy_sid(source: PSID) -> io::Result<AlignedBuffer> {
    if source.0.is_null() || !unsafe { IsValidSid(source) }.as_bool() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Windows returned an invalid current-user principal",
        ));
    }
    let size = unsafe { GetLengthSid(source) };
    let mut result = AlignedBuffer::new(size as usize)?;
    // SAFETY: source is a valid SID and the destination has GetLengthSid bytes.
    unsafe { CopySid(size, result.sid_mut(), source) }.map_err(io_error)?;
    Ok(result)
}

fn private_dacl(owner: PSID, system: PSID) -> io::Result<AlignedBuffer> {
    let owner_size = unsafe { GetLengthSid(owner) } as usize;
    let owner_is_system = sid_equal(owner, system);
    let system_size = if owner_is_system {
        0
    } else {
        (unsafe { GetLengthSid(system) }) as usize
    };
    let fixed_ace_size = size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>();
    let fixed_aces_size = fixed_ace_size
        .checked_mul(if owner_is_system { 1 } else { 2 })
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Windows ACL is too large"))?;
    let size = size_of::<ACL>()
        .checked_add(fixed_aces_size)
        .and_then(|value| value.checked_add(owner_size))
        .and_then(|value| value.checked_add(system_size))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Windows ACL is too large"))?;
    let size = u32::try_from(size)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Windows ACL is too large"))?;
    let mut dacl = AlignedBuffer::new(size as usize)?;

    // SAFETY: dacl is aligned and has `size` writable bytes; both SIDs are
    // validated buffers retained by the caller.
    unsafe {
        InitializeAcl(dacl.acl(), size, ACL_REVISION).map_err(io_error)?;
        AddAccessAllowedAceEx(
            dacl.acl(),
            ACL_REVISION,
            ACE_FLAGS(u32::from(PRIVATE_ACE_FLAGS)),
            FILE_ALL_ACCESS.0,
            owner,
        )
        .map_err(io_error)?;
        if !owner_is_system {
            AddAccessAllowedAceEx(
                dacl.acl(),
                ACL_REVISION,
                ACE_FLAGS(u32::from(PRIVATE_ACE_FLAGS)),
                FILE_ALL_ACCESS.0,
                system,
            )
            .map_err(io_error)?;
        }
    }
    Ok(dacl)
}

fn sid_equal(left: PSID, right: PSID) -> bool {
    if left.0.is_null()
        || right.0.is_null()
        || !unsafe { IsValidSid(left) }.as_bool()
        || !unsafe { IsValidSid(right) }.as_bool()
    {
        return false;
    }
    let left_size = unsafe { GetLengthSid(left) } as usize;
    let right_size = unsafe { GetLengthSid(right) } as usize;
    if left_size != right_size {
        return false;
    }
    // SAFETY: both validated SID allocations contain their reported sizes.
    unsafe {
        std::slice::from_raw_parts(left.0.cast::<u8>(), left_size)
            == std::slice::from_raw_parts(right.0.cast::<u8>(), right_size)
    }
}

fn invalid_security(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

#[derive(Clone, Copy)]
enum AcePolicy {
    ExplicitDirectory,
    ExplicitFile,
    InheritedFile,
}

impl AcePolicy {
    fn is_explicit(self) -> bool {
        matches!(self, Self::ExplicitDirectory | Self::ExplicitFile)
    }

    fn accepts(self, flags: u8) -> bool {
        match self {
            Self::ExplicitDirectory => flags == PRIVATE_ACE_FLAGS,
            Self::ExplicitFile => flags == 0 || flags == PRIVATE_ACE_FLAGS,
            Self::InheritedFile => {
                let allowed = PRIVATE_ACE_FLAGS | INHERITED_ACE.0 as u8;
                flags & INHERITED_ACE.0 as u8 != 0 && flags & !allowed == 0
            }
        }
    }
}

struct AlignedBuffer(Box<[usize]>);

impl AlignedBuffer {
    fn new(bytes: usize) -> io::Result<Self> {
        let words = bytes
            .checked_add(size_of::<usize>() - 1)
            .map(|size| size / size_of::<usize>())
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "buffer is too large"))?;
        if words == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Windows security buffer cannot be empty",
            ));
        }
        Ok(Self(vec![0usize; words].into_boxed_slice()))
    }

    fn as_ptr(&self) -> *const c_void {
        self.0.as_ptr().cast()
    }

    fn as_mut_ptr(&mut self) -> *mut c_void {
        self.0.as_mut_ptr().cast()
    }

    fn sid(&self) -> PSID {
        // Windows models input SIDs with PSID rather than a const pointer. This
        // accessor is used only for APIs that read the SID.
        PSID(self.as_ptr().cast_mut())
    }

    fn sid_mut(&mut self) -> PSID {
        PSID(self.as_mut_ptr())
    }

    fn acl(&mut self) -> *mut ACL {
        self.as_mut_ptr().cast()
    }
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: this wrapper exclusively owns the successful OpenProcessToken
        // result. Close errors cannot be recovered during Drop.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

struct LocalDescriptor(PSECURITY_DESCRIPTOR);

impl Drop for LocalDescriptor {
    fn drop(&mut self) {
        let pointer = (self.0).0;
        if !pointer.is_null() {
            // SAFETY: GetSecurityInfo documents LocalFree for this allocation.
            let _ = unsafe { LocalFree(Some(HLOCAL(pointer))) };
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{ffi::OsStr, fs};

    use super::super::Directory;
    use super::{validate_inherited_file, validate_private};

    #[test]
    fn private_directory_confines_native_and_ordinary_child_files() {
        let temporary = tempfile::tempdir().expect("temporary root");
        let root = Directory::open(temporary.path()).expect("open temporary root");
        let private = root
            .create_directory(OsStr::new("private"))
            .expect("create private directory");
        validate_private(&private.file).expect("private directory descriptor");

        let native = private
            .create_file(OsStr::new("native.db"))
            .expect("create native file");
        validate_private(&native).expect("native file descriptor");

        let ordinary_path = temporary.path().join("private").join("ordinary.db-wal");
        fs::write(&ordinary_path, b"sidecar").expect("create ordinary child");
        let ordinary = fs::File::open(ordinary_path).expect("open ordinary child");
        validate_inherited_file(&ordinary).expect("ordinary child inherited descriptor");
    }
}
