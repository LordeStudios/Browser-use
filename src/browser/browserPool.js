import { launchControlledBrowser, killBrowserTree } from './chromeLauncher.js';
import { CdpBrowser } from './cdpClient.js';

export class BrowserPool {
  constructor(opts={}){
    this.opts=opts;
    this.launch=null;
    this.endpoint=null;
    this.tabs=[];
    this.size=Number(opts.poolSize||3);
  }

  async start(){
    this.launch=await launchControlledBrowser({url:'about:blank'});
    this.endpoint=this.launch.endpoint;
    const tabs=await this.listTabs();
    const pageTabs=tabs.filter(t=>t.type==='page');
    for(const t of pageTabs.slice(0,this.size)){
      const b=new CdpBrowser(this.endpoint);
      await b.selectTab(t.id);
      this.tabs.push({id:t.id,browser:b,ready:true});
    }
    while(this.tabs.length < this.size){
      const b=new CdpBrowser(this.endpoint);
      const tab=await b.createTab('about:blank');
      this.tabs.push({id:tab.id,browser:b,ready:true});
    }
    return {endpoint:this.endpoint,size:this.tabs.length};
  }

  async listTabs(){
    const host=new URL(this.endpoint).hostname;
    const port=Number(new URL(this.endpoint).port);
    const CDP=(await import('chrome-remote-interface')).default;
    return await CDP.List({host,port});
  }

  acquire(){
    const idx=this.tabs.findIndex(t=>t.ready);
    if(idx<0) return null;
    const tab=this.tabs[idx];
    tab.ready=false;
    return tab.browser;
  }

  release(browser){
    const tab=this.tabs.find(t=>t.browser===browser);
    if(!tab) return;
    tab.ready=true;
  }

  async reset(browser){
    const tab=this.tabs.find(t=>t.browser===browser);
    if(!tab) return;
    try{
      await browser.navigate('about:blank');
    }catch{
      try{
        const b=new CdpBrowser(this.endpoint);
        const t=await b.createTab('about:blank');
        tab.id=t.id; tab.browser=b;
      }catch{}
    }
    tab.ready=true;
  }

  async stop(){
    for(const t of this.tabs){ try{ await t.browser.close(); }catch{} }
    this.tabs=[];
    await killBrowserTree(this.launch);
  }
}
