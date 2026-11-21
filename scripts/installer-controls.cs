using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

// NSIS controls can appear as UI Automation panes. Use their actual Win32 class and state.
public static class InstallerControls {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern int GetClassName(IntPtr handle, StringBuilder name, int count);
    [DllImport("user32.dll", SetLastError = true)] static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SendMessageTimeout(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    public static string ClassName(int handle) {
        var name = new StringBuilder(256);
        if (GetClassName(new IntPtr(handle), name, name.Capacity) == 0) throw new Win32Exception();
        return name.ToString();
    }
    public static int CheckState(int handle) {
        if (ClassName(handle) != "Button") throw new InvalidOperationException("Expected a native button control.");
        IntPtr result;
        if (SendMessageTimeout(new IntPtr(handle), 0x00F0, IntPtr.Zero, IntPtr.Zero, 2, 2000, out result) == IntPtr.Zero) throw new Win32Exception();
        return result.ToInt32();
    }
    public static void Click(int handle) {
        if (ClassName(handle) != "Button") throw new InvalidOperationException("Expected a native button control.");
        if (!PostMessage(new IntPtr(handle), 0x00F5, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
    }
}
