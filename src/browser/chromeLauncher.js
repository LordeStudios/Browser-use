import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { repoRoot } from '../config.js';

const bins=['google-chrome','google-chrome-stable','chromium','chromium-browser','chrome'];

function getProfileBase(){
  if(process.env.BROWSER_USE_PROFILE_DIR && fs.existsSync(process.env.BROWSER_USE_PROFILE_DIR)){
    return process.env.BROWSER_USE_PROFILE_DIR;
  }
  return os.tmpdir();
}

async function findChrome(){
  if(process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if(process.platform === 'win32'){
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google/Chrome/Application/chrome.exe')
    ];
    for(const p of paths){ if(fs.existsSync(p)) return p; }
    try {
      const p = execSync('where chrome', {encoding:'utf8'}).split('\\r\\n')[0].trim();
      if(p && fs.existsSync(p)) return p;
    } catch {}
  } else {
    for(const b of bins){
      try{ const p=execFileSync('which',[b],{encoding:'utf8'}).trim(); if(p) return p; }catch{}
    }
  }
  throw new Error('No Chrome/Chromium binary found. Set CHROME_PATH or install chromium.');
}

async function isPortInUse(port, host='127.0.0.1'){
  try {
    const r = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch { return false; }
}

export async function launchControlledBrowser({port=9222,url='about:blank',sessionId=null,logger=null}={}){
  const bin=await findChrome();
  const profileBase = getProfileBase();
  const profile = sessionId
    ? path.join(profileBase, `browser-use-profile-${sessionId}`)
    : path.join(profileBase,'browser-use-profile-default');
  fs.mkdirSync(profile,{recursive:true});
  let actualPort = port;
  for (let i = 0; i < 40; i++) {
    if (!(await isPortInUse(actualPort))) break;
    actualPort = port + i + 1;
  }
  const args=[
    '--new-window',
    '--start-maximized',
    `--remote-debugging-port=${actualPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-background-timer-throttling',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-hang-monitor',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-renderer-backgrounding',
    '--disable-sync',
    '--force-color-profile=srgb',
    '--metrics-recording-only',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-features=IsolateOrigins,site-per-process,TranslateUI',
    url
  ];
  const stderrLog = path.join(profile, 'chrome-stderr.log');
  const stderrFd = fs.openSync(stderrLog, 'w');
  const child=spawn(bin,args,{stdio:['ignore','ignore',stderrFd],detached:false});
  child.on('error',(err)=>{ logger?.('chrome.process.error', {error:err.message}); });
  try{
    await waitForCdp(`http://127.0.0.1:${actualPort}`, 20000);
  }catch(e){
    try{ child.kill('SIGKILL'); }catch{}
    let stderrTail='';
    try{ stderrTail=fs.readFileSync(stderrLog,'utf8').slice(-2000); }catch{}
    throw new Error(`${e.message} | stderr tail: ${stderrTail}`);
  }
  return {mode:'controlled',process:child,endpoint:`http://127.0.0.1:${actualPort}`,port:actualPort,profile,pid:child.pid,stderrLog};
}

export async function waitForCdp(endpoint, timeout=20000){
  const start=Date.now();
  while(Date.now()-start<timeout){
    try{ const r=await fetch(`${endpoint}/json/version`); if(r.ok) return await r.json(); }catch{}
    await new Promise(r=>setTimeout(r,250));
  }
  throw new Error(`Timed out waiting for CDP at ${endpoint}`);
}

export function normalizeEndpoint(connect){ if(!connect) return null; return connect.replace(/\/$/,''); }

export async function killBrowserTree(launch){
  if(!launch || !launch.process) return {killed:false,reason:'no launch'};
  const pid = launch.pid || launch.process.pid;
  // Durable profiles (explicit BROWSER_USE_PROFILE_DIR) survive shutdown so
  // site logins persist across daemon restarts. Ephemeral profiles stay
  // auto-cleaned exactly as before.
  try { if(launch.profile && !process.env.BROWSER_USE_PROFILE_DIR) fs.rmSync(launch.profile, { recursive: true, force: true }); } catch {}
  if(!pid) return {killed:false,reason:'no pid'};
  try {
    if(process.platform === 'win32'){
      try {
        execSync(`taskkill /T /F /PID ${pid}`,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
      } catch {
        try { launch.process.kill('SIGKILL'); } catch {}
      }
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { launch.process.kill('SIGKILL'); }
    }
  } catch (e) {
    try { launch.process.kill('SIGKILL'); } catch {}
    return {killed:true,pid,warning:e.message};
  }
  return {killed:true,pid};
}