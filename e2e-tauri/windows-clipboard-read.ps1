# Read the eagerly published CF_HDROP block without Shell/OLE clipboard cmdlets.
# Keep this independent of the application and fail on native errors.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class NativeFileClipboardProbe {
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseClipboard();
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetClipboardData(uint format);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint DragQueryFileW(IntPtr drop, uint index, StringBuilder path, uint capacity);

    public static string[] Read() {
        if (!OpenClipboard(IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenClipboard failed");
        try {
            if (!IsClipboardFormatAvailable(15)) return new string[0];
            IntPtr drop = GetClipboardData(15); // CF_HDROP
            if (drop == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetClipboardData failed");
            uint count = DragQueryFileW(drop, UInt32.MaxValue, null, 0);
            var paths = new List<string>();
            for (uint index = 0; index < count; index++) {
                uint length = DragQueryFileW(drop, index, null, 0);
                var path = new StringBuilder(checked((int)length + 1));
                if (length == 0 || DragQueryFileW(drop, index, path, (uint)path.Capacity) != length)
                    throw new InvalidOperationException("DragQueryFileW returned an incomplete path");
                paths.Add(path.ToString());
            }
            return paths.ToArray();
        } finally {
            CloseClipboard();
        }
    }
}
'@
ConvertTo-Json -Compress -InputObject @([NativeFileClipboardProbe]::Read())
