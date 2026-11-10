'use strict';
// Isolated renderer entry: no desktop capture, user profile, native input or shell.
const {app,BrowserWindow}=require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed',()=>app.quit());
app.whenReady().then(async()=>{
  const window=new BrowserWindow({show:false,width:1000,height:700,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  await window.loadURL('data:text/html,<title>Generated sandbox renderer</title>');
});
