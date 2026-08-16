Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "c:\Users\iarme\OneDrive\Documents\My Guestbook"
WshShell.Run "node_modules\.bin\electron.cmd .", 1, False
