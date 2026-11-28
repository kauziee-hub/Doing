$ErrorActionPreference='Stop'
trap { [Console]::Error.WriteLine($_.Exception.GetBaseException().Message); exit 1 }
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$dll=Join-Path $PSScriptRoot 'accessibility/Interop.UIAutomationClient.dll'
Add-Type -Path $dll
Add-Type -ReferencedAssemblies $dll -TypeDefinition @'
using System; using System.Collections.Generic; using System.Diagnostics; using System.Runtime.InteropServices; using Interop.UIAutomationClient;
public class DoingUi3Control {
 public string runtime, name, type, value, context; public string[] actions;
}
public class DoingUi3View {
 public string handle,process,title; public int processId; public DoingUi3Control[] controls;
}
public static class DoingUi3 {
 static IUIAutomation uia=new CUIAutomation8Class();
 static IUIAutomationElement activeWindow;
 public static void Open(string name,string handle,int pid){activeWindow=Window(name,handle,pid);}
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h,int state);
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [StructLayout(LayoutKind.Explicit,Size=40)] struct KeyInput { [FieldOffset(0)] public uint type; [FieldOffset(8)] public ushort key; [FieldOffset(10)] public ushort scan; [FieldOffset(12)] public uint flags; }
 [DllImport("user32.dll")] static extern uint SendInput(uint count,KeyInput[] inputs,int size);
 [DllImport("user32.dll")] static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
 public static string Runtime(IUIAutomationElement e){return String.Join(".",e.GetRuntimeId());}
 static string Cut(string value,int max){return (value??"").Length>max?value.Substring(0,max):value??"";}
 public static IUIAutomationElement Window(string name,string handle,int pid){
  ((IUIAutomation2)uia).ConnectionTimeout=3000; ((IUIAutomation2)uia).TransactionTimeout=3000;
  if(!String.IsNullOrEmpty(handle)){var el=uia.ElementFromHandle(new IntPtr(Int64.Parse(handle)));if(el.CurrentProcessId!=pid)throw new Exception("The app window was replaced. Read the app again.");return el;}
  var windows=uia.GetRootElement().FindAll(TreeScope.TreeScope_Children,uia.CreateTrueCondition());var processMatches=new List<IUIAutomationElement>();var titleMatches=new List<IUIAutomationElement>();
  for(int i=0;i<windows.Length;i++){var el=windows.GetElement(i);try{var process=Process.GetProcessById(el.CurrentProcessId).ProcessName;
   if(process.Equals(name,StringComparison.OrdinalIgnoreCase)||process.StartsWith(name+".",StringComparison.OrdinalIgnoreCase))processMatches.Add(el);
   if(el.CurrentName.IndexOf(name,StringComparison.OrdinalIgnoreCase)>=0)titleMatches.Add(el);
  }catch{}}
  var matches=processMatches.Count>0?processMatches:titleMatches;
  if(matches.Count!=1)throw new Exception(matches.Count==0?"No matching open app. Open it first, then read it.":"Several windows match. Tell me the exact window title.");return matches[0];
 }
 public static string Context(IUIAutomationElement el){
  var parts=new List<string>();var walker=uia.ControlViewWalker;var current=walker.GetParentElement(el);
  for(int i=0;i<5&&current!=null;i++){
   var role=Convert.ToString(current.GetCurrentPropertyValue(30101));
   parts.Add(Cut(current.CurrentName,100)+" role="+role+" id="+current.CurrentAutomationId+" type="+current.CurrentControlType);
   if(current.CurrentNativeWindowHandle!=IntPtr.Zero)break;current=walker.GetParentElement(current);
  }
  return Cut(String.Join(" | ",parts),700);
 }
 public static string[] Actions(IUIAutomationElement el){
  var result=new List<string>();
  foreach(int id in new int[]{10000,10015,10010,10005})try{if(el.GetCurrentPattern(id)!=null){result.Add("click");break;}}catch{}
  try{var value=(IUIAutomationValuePattern)el.GetCurrentPattern(10002);if(value.CurrentIsReadOnly==0 && (el.CurrentControlType==50004||el.CurrentControlType==50003||el.CurrentControlType==50025)){result.Add("type");result.Add("enter");}}catch{}
  try{var scroll=(IUIAutomationScrollPattern)el.GetCurrentPattern(10004);if(scroll.CurrentVerticallyScrollable!=0){result.Add("scroll_down");result.Add("scroll_up");}}catch{}
  return result.ToArray();
 }
 public static string Value(IUIAutomationElement el){
  try{var value=((IUIAutomationValuePattern)el.GetCurrentPattern(10002)).CurrentValue;if(!String.IsNullOrEmpty(value))return value;}catch{}
  if(el.CurrentControlType==50004||el.CurrentControlType==50003||el.CurrentControlType==50025)try{return ((IUIAutomationTextPattern)el.GetCurrentPattern(10014)).DocumentRange.GetText(4000).TrimEnd('\r');}catch{}
  return "";
 }
 static bool Focused(IUIAutomationElement target){
  if(target.CurrentHasKeyboardFocus!=0)return true;
  var focus=uia.GetFocusedElement();if(uia.CompareElements(focus,target)!=0)return true;
  var a=focus.CurrentBoundingRectangle;var b=target.CurrentBoundingRectangle;
  return focus.CurrentControlType==target.CurrentControlType&&focus.CurrentIsPassword==0&&b.right>b.left&&a.left==b.left&&a.right==b.right&&a.top==b.top&&a.bottom==b.bottom;
 }
 static void Type(IUIAutomationElement window,IUIAutomationElement target,string text){
  try{((IUIAutomationValuePattern)target.GetCurrentPattern(10002)).SetValue(text);}catch{}
  for(int i=0;i<5;i++){if(Value(target)==text)return;System.Threading.Thread.Sleep(50);}
  if(text.IndexOf('\n')>=0||text.IndexOf('\r')>=0)throw new Exception("This app did not accept the multiline message. Nothing was sent.");
  var handle=window.CurrentNativeWindowHandle;ShowWindow(handle,9);SetForegroundWindow(handle);target.SetFocus();
  if(GetForegroundWindow()!=handle)throw new Exception("Windows could not bring the requested app to the foreground.");
  if(!Focused(target))throw new Exception("Windows could not confirm focus in the requested field.");
  keybd_event(17,0,0,UIntPtr.Zero);keybd_event(65,0,0,UIntPtr.Zero);keybd_event(65,0,2,UIntPtr.Zero);keybd_event(17,0,2,UIntPtr.Zero);
  if(text.Length==0){keybd_event(8,0,0,UIntPtr.Zero);keybd_event(8,0,2,UIntPtr.Zero);}
  var inputs=new KeyInput[text.Length*2];for(int i=0;i<text.Length;i++){inputs[i*2]=new KeyInput{type=1,scan=text[i],flags=4};inputs[i*2+1]=new KeyInput{type=1,scan=text[i],flags=6};}
  if(inputs.Length>0&&SendInput((uint)inputs.Length,inputs,40)!=inputs.Length)throw new Exception("Windows did not accept all of the requested text.");
  for(int i=0;i<20;i++){System.Threading.Thread.Sleep(50);if(Value(target)==text)return;}
  throw new Exception("The app did not confirm the requested text.");
 }
 public static List<IUIAutomationElement> Elements(IUIAutomationElement window){
  var cache=uia.CreateCacheRequest();foreach(int id in new int[]{30000,30001,30003,30005,30010,30019,30022})cache.AddProperty(id);
  var document=window.FindFirst(TreeScope.TreeScope_Descendants,uia.CreatePropertyCondition(30003,50030));
  var scope=document??window;
  var all=scope.FindAllBuildCache(TreeScope.TreeScope_Descendants,uia.CreateAndCondition(uia.ControlViewCondition,uia.CreatePropertyCondition(30022,false)),cache);
  var result=new List<IUIAutomationElement>();var seen=new HashSet<string>();
  for(int i=0;i<all.Length&&result.Count<220;i++){var el=all.GetElement(i);try{
   if(el.CachedIsPassword!=0||el.CachedIsEnabled==0||el.CachedIsOffscreen!=0)continue;
   var rect=el.CachedBoundingRectangle;int type=el.CachedControlType;string name=el.CachedName;
   if(rect.right<=rect.left||rect.bottom<=rect.top)continue;
   string key=type+"|"+name+"|"+rect.left+","+rect.top+","+rect.right+","+rect.bottom;if(!seen.Add(key))continue;
   if(type==50018||type==50032||type==50033||type==50037||type==50021)continue;
   if(type==50004||type==50003||type==50000||type==50007||type==50011||type==50019||type==50020||type==50025||type==50028||type==50029||type==50030||type==50008)result.Add(el);
  }catch{}}
  return result;
 }
 static string Kind(int type){switch(type){case 50004:return "Edit";case 50003:return "ComboBox";case 50000:return "Button";case 50007:return "ListItem";case 50029:return "DataItem";case 50020:return "Text";case 50019:return "TabItem";case 50028:return "DataGrid";case 50008:return "List";case 50025:return "Custom";case 50026:return "Group";case 50011:return "MenuItem";default:return "Control";}}
 public static DoingUi3View Read(){
  var window=activeWindow;
  string process=Process.GetProcessById(window.CurrentProcessId).ProcessName;
  if(!process.StartsWith("WhatsApp",StringComparison.OrdinalIgnoreCase)&&process!="DoingMessagingFixture")throw new Exception("This window is outside messaging app control.");
  var nodes=Elements(window);var controls=new List<DoingUi3Control>();
  foreach(var el in nodes)try{var name=Cut(el.CurrentName,4000);var actions=Actions(el);if(name.Length==0&&actions.Length==0)continue;
   controls.Add(new DoingUi3Control{runtime=Runtime(el),name=name,type="ControlType."+Kind(el.CurrentControlType),value=Cut(Value(el),4000),context=Context(el),actions=actions});
  }catch{}
  return new DoingUi3View{handle=window.CurrentNativeWindowHandle.ToInt64().ToString(),processId=window.CurrentProcessId,process=process,title=window.CurrentName,controls=controls.ToArray()};
 }
 public static void Act(string runtime,string name,string type,string action,string text){
  var window=activeWindow;
  IUIAutomationElement target=null;foreach(var el in Elements(window))if(Runtime(el)==runtime){target=el;break;}
  if(target==null||target.CurrentName!=name||"ControlType."+Kind(target.CurrentControlType)!=type||target.CurrentIsPassword!=0||target.CurrentIsEnabled==0||target.CurrentIsOffscreen!=0)throw new Exception("The app control changed. Read the app again.");
  if(action=="type"){Type(window,target,text);}
  else if(action=="enter"){var handle=window.CurrentNativeWindowHandle;ShowWindow(handle,9);SetForegroundWindow(handle);target.SetFocus();if(GetForegroundWindow()!=handle)throw new Exception("Windows could not bring the requested app to the foreground.");
  if(!Focused(target))throw new Exception("Windows could not confirm focus in the requested field.");keybd_event(13,0,0,UIntPtr.Zero);keybd_event(13,0,2,UIntPtr.Zero);}
  else if(action.StartsWith("scroll_")){((IUIAutomationScrollPattern)target.GetCurrentPattern(10004)).Scroll(ScrollAmount.ScrollAmount_NoAmount,action=="scroll_down"?ScrollAmount.ScrollAmount_LargeIncrement:ScrollAmount.ScrollAmount_LargeDecrement);}
  else if(action=="click"){
   object pattern=null;try{pattern=target.GetCurrentPattern(10000);}catch{} if(pattern!=null){((IUIAutomationInvokePattern)pattern).Invoke();return;}
   try{pattern=target.GetCurrentPattern(10010);}catch{}if(pattern!=null){((IUIAutomationSelectionItemPattern)pattern).Select();return;}
   try{pattern=target.GetCurrentPattern(10015);}catch{}if(pattern!=null){((IUIAutomationTogglePattern)pattern).Toggle();return;}
   throw new Exception("This control does not support an accessible click.");
  }else throw new Exception("Unsupported app action.");
 }
}
'@
$a=$env:DOING_DESKTOP_ARG | ConvertFrom-Json
[DoingUi3]::Open([string]$a.name,[string]$a.handle,[int]$a.processId)
$view=[DoingUi3]::Read()
function Revision($controls) {
 $sha=[Security.Cryptography.SHA256]::Create()
 $semantic=@($controls | Select-Object name,type,value,context,actions)
 try { [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $semantic -Depth 6 -Compress)))).Replace('-','') } finally {$sha.Dispose()}
}
if($a.action){
 if(-not $a.revision -or (Revision $view.controls) -ne $a.revision){throw 'The app changed while I was thinking. Read the app again before acting.'}
 [DoingUi3]::Act([string]$a.runtime,[string]$a.name,[string]$a.type,[string]$a.action,[string]$a.text)
 Start-Sleep -Milliseconds 250
 $view=[DoingUi3]::Read()
}
$result=[ordered]@{handle=$view.handle;processId=$view.processId;process=$view.process;title=$view.title;revision=(Revision $view.controls);controls=@($view.controls)}
ConvertTo-Json -InputObject $result -Depth 6 -Compress
