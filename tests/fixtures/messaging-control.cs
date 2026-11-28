using System;
using System.Windows.Forms;
public static class MessagingFixture {
 [STAThread] public static void Main(){
  Application.EnableVisualStyles();
  var form=new Form{Text="Doing Messaging Fixture",Width=650,Height=380};
  var info=new Label{Text="LOCAL MESSAGING FIXTURE - no external messages",Top=10,Width=600};
  var search=new TextBox{AccessibleName="Search contacts",Name="Search",Top=45,Width=400};
  var contact=new Button{Text="Open Alex Example chat",AccessibleName="Open Alex Example chat",Top=85,Width=200,Visible=false};
  var header=new Label{Text="Choose a contact",Top=125,Width=600};
  var message=new TextBox{AccessibleName="Type a message",Name="Message",Top=160,Width=550,Visible=false};
  var send=new Button{Text="Send",Top=200,Visible=false,Enabled=false};
  var result=new Label{Text="No messages sent",Top=245,Width=600};
  var count=new Label{Text="Send count: 0",Top=275,Width=600};int sent=0;
  search.TextChanged+=(s,e)=>contact.Visible=search.Text=="Alex Example";
  contact.Click+=(s,e)=>{search.Visible=false;contact.Visible=false;header.Text="Chat with: Alex Example";message.Visible=true;send.Visible=true;};
  message.TextChanged+=(s,e)=>send.Enabled=message.Text.Length>0;
  send.Click+=(s,e)=>{result.Text="Sent: "+message.Text;count.Text="Send count: "+(++sent);message.Clear();};
  form.Controls.AddRange(new Control[]{info,search,contact,header,message,send,result,count});
  Application.Run(form);
 }
}
