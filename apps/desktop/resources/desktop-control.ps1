$ErrorActionPreference = 'Stop'
trap { [Console]::Error.WriteLine($_.Exception.GetBaseException().Message); exit 1 }
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Automation;
public static class DoingDesktop {
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  public static string Runtime(AutomationElement e) { return String.Join(".", e.GetRuntimeId()); }
  public static AutomationElement Window(string name, string handle, int pid) {
    if (!String.IsNullOrEmpty(handle)) {
      var w = AutomationElement.FromHandle(new IntPtr(Int64.Parse(handle)));
      if (w.Current.ProcessId != pid) throw new Exception("The app window was replaced. Read the app again.");
      return w;
    }
    var windows = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
    var matches = new List<AutomationElement>();
    foreach (AutomationElement w in windows) { try {
      var p = Process.GetProcessById(w.Current.ProcessId).ProcessName;
      if (w.Current.Name.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0 || p.Equals(name, StringComparison.OrdinalIgnoreCase)) matches.Add(w);
    } catch {} }
    if (matches.Count != 1) throw new Exception(matches.Count == 0 ? "No matching open app. Open it first, then read it." : "Several windows match. Tell me the exact window title.");
    return matches[0];
  }
  public static List<AutomationElement> Elements(AutomationElement w) {
    var result = new List<AutomationElement>();
    var queue = new Queue<AutomationElement>(); queue.Enqueue(w);
    var walker = TreeWalker.ControlViewWalker;
    int count = 0;
    while (queue.Count > 0 && count++ < 1500 && result.Count < 180) {
      var e = queue.Dequeue();
      try {
        if (e.Current.ControlType == ControlType.TitleBar || e.Current.Name == "System Menu Bar") continue;
        if (!e.Current.IsOffscreen && !e.Current.IsPassword && e.Current.IsEnabled) result.Add(e);
        var child = walker.GetFirstChild(e);
        while (child != null && queue.Count < 1500) { queue.Enqueue(child); child = walker.GetNextSibling(child); }
      } catch (ElementNotAvailableException) { }
    }
    return result;
  }
  public static List<string> Actions(AutomationElement e) {
    var a = new List<string>(); object p;
    if (e.TryGetCurrentPattern(InvokePattern.Pattern, out p) || e.TryGetCurrentPattern(TogglePattern.Pattern, out p) || e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p) || e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) a.Add("click");
    if (e.TryGetCurrentPattern(ValuePattern.Pattern, out p) && !((ValuePattern)p).Current.IsReadOnly) { a.Add("type"); a.Add("enter"); }
    if (e.TryGetCurrentPattern(ScrollPattern.Pattern, out p) && ((ScrollPattern)p).Current.VerticallyScrollable) { a.Add("scroll_down"); a.Add("scroll_up"); }
    return a;
  }
  public static string Value(AutomationElement e) {
    object p;
    if (e.TryGetCurrentPattern(ValuePattern.Pattern, out p)) return ((ValuePattern)p).Current.Value;
    if (e.TryGetCurrentPattern(TogglePattern.Pattern, out p)) return ((TogglePattern)p).Current.ToggleState.ToString();
    if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) return ((SelectionItemPattern)p).Current.IsSelected.ToString();
    return "";
  }
  public static void Act(AutomationElement w, string runtime, string name, string type, string action, string text) {
    AutomationElement target = null;
    foreach (var e in Elements(w)) if (Runtime(e) == runtime) { target = e; break; }
    if (target == null || target.Current.Name != name || target.Current.ControlType.ProgrammaticName != type || target.Current.IsPassword || !target.Current.IsEnabled || target.Current.IsOffscreen) throw new Exception("The app control changed. Read the app again.");
    object pattern;
    if (action == "type") {
      var v = (ValuePattern)target.GetCurrentPattern(ValuePattern.Pattern);
      if (v.Current.IsReadOnly) throw new Exception("This field is read-only.");
      v.SetValue(text);
      if (v.Current.Value != text) throw new Exception("The app did not confirm the requested text.");
    } else if (action == "enter") {
      var h = new IntPtr(w.Current.NativeWindowHandle);
      ShowWindow(h, 9); SetForegroundWindow(h);
      if (GetForegroundWindow() != h) throw new Exception("Windows could not focus the target app. Bring it to the front and try again.");
      target.SetFocus();
      if (!Automation.Compare(AutomationElement.FocusedElement, target) || GetForegroundWindow() != h) throw new Exception("The requested field is not focused.");
      keybd_event(13, 0, 0, UIntPtr.Zero); keybd_event(13, 0, 2, UIntPtr.Zero);
    } else if (action.StartsWith("scroll_")) {
      var s = (ScrollPattern)target.GetCurrentPattern(ScrollPattern.Pattern);
      double before = s.Current.VerticalScrollPercent;
      s.Scroll(ScrollAmount.NoAmount, action == "scroll_down" ? ScrollAmount.LargeIncrement : ScrollAmount.LargeDecrement);
      if (s.Current.VerticalScrollPercent == before) throw new Exception("The app did not scroll further.");
    } else if (action == "click") {
      if (target.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) ((InvokePattern)pattern).Invoke();
      else if (target.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) ((TogglePattern)pattern).Toggle();
      else if (target.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) ((SelectionItemPattern)pattern).Select();
      else if (target.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) { var x = (ExpandCollapsePattern)pattern; if (x.Current.ExpandCollapseState == ExpandCollapseState.Expanded) x.Collapse(); else x.Expand(); }
      else throw new Exception("This control does not expose an accessible click action.");
    } else throw new Exception("Unsupported app action.");
  }
}
'@
$a = $env:DOING_DESKTOP_ARG | ConvertFrom-Json
$w = [DoingDesktop]::Window([string]$a.name, [string]$a.handle, [int]$a.processId)
$proc = (Get-Process -Id $w.Current.ProcessId).ProcessName
# Apply before any mutation too, not only to the returned observation.
if ($proc -match '^(Doing|electron|chrome|msedge|firefox|brave|opera|ApplicationFrameHost|powershell|pwsh|cmd|WindowsTerminal|regedit|mmc|Taskmgr|SecHealthUI|consent)$' -or $w.Current.Name -match '(?i)Windows Security|Registry Editor|PowerShell|Command Prompt') { throw 'This window is outside app control.' }
function Read-DoingControls {
@([DoingDesktop]::Elements($w) | ForEach-Object {
  $e = $_
  try {
    $name = $e.Current.Name
    $actions = @([DoingDesktop]::Actions($e))
    if ($name -or $actions.Count) {
      if ($name.Length -gt 240) { $name = $name.Substring(0, 240) }
      $value = [DoingDesktop]::Value($e)
      if ($value.Length -gt 700) { $value = $value.Substring(0, 700) }
      [pscustomobject]@{ runtime = [DoingDesktop]::Runtime($e); name = $name; type = $e.Current.ControlType.ProgrammaticName; value = $value; actions = @($actions) }
    }
  } catch { }
})
}
function Get-DoingRevision($controls) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  # Runtime IDs are checked on the actual target. Other providers may recreate nodes without changing the app state.
  $semantic = @($controls | Select-Object name, type, value, actions)
  try { [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $semantic -Depth 6 -Compress)))).Replace('-', '') } finally { $sha.Dispose() }
}
$controls = @(Read-DoingControls)
if ($a.action) {
  if (-not $a.revision -or (Get-DoingRevision $controls) -ne $a.revision) { throw 'The app changed while I was thinking. Read the app again before acting.' }
  [DoingDesktop]::Act($w, [string]$a.runtime, [string]$a.name, [string]$a.type, [string]$a.action, [string]$a.text)
  Start-Sleep -Milliseconds 250
  $controls = @(Read-DoingControls)
}
[pscustomobject]@{ handle = [string]$w.Current.NativeWindowHandle; processId = $w.Current.ProcessId; process = $proc; title = $w.Current.Name; revision = (Get-DoingRevision $controls); controls = @($controls) } | ConvertTo-Json -Depth 6 -Compress
