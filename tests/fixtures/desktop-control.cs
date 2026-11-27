using System;
using System.Windows.Forms;
public static class DesktopFixture {
  [STAThread] public static void Main() {
    Application.EnableVisualStyles();
    var form = new Form { Text = "Doing Automation Fixture", Width = 560, Height = 340 };
    var contact = new Label { Text = "Contact: Alex Example (local fixture)", Top = 5, Width = 450 };
    var message = new TextBox { Name = "Message", AccessibleName = "Message", Width = 350, Top = 35 };
    var send = new Button { Text = "Send", Top = 70 };
    var result = new Label { Text = "Not sent", Top = 110, Width = 450 };
    int count = 0;
    send.Click += (s, e) => { result.Text = "Sent " + (++count) + ": " + message.Text; };
    var panel = new Panel { Top = 145, Width = 480, Height = 100, AutoScroll = true };
    for (int i = 0; i < 20; i++) panel.Controls.Add(new Label { Text = "Scroll row " + i, Top = i * 28, Width = 350 });
    form.Controls.AddRange(new Control[] { contact, message, send, result, panel });
    Application.Run(form);
  }
}
