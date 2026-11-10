import pathlib
p=pathlib.Path('E:/Users/maximus/Documents/GitHub/uganda-art-pulse/tools/browser-use/src/browser/cdpClient.js')
src=p.read_text(encoding='utf-8')
old = 'async selectTab(id){ if(this.client) await this.client.close(); const tabs = await this.listTabs(); this.target=id ? {id} : tabs.find(t=>t.type==="page");'
new = 'async selectTab(id){ if(this.client) await this.client.close(); const tabs = await this.listTabs(); if(id){ this.target = tabs.find(t=>t.id===id) || {id}; } else { this.target = tabs.find(t=>t.type==="page"); }'
src=src.replace(old,new)
p.write_text(src,encoding='utf-8')
print('fixed selectTab')
