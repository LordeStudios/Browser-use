import pathlib
p=pathlib.Path('E:/Users/maximus/Documents/GitHub/uganda-art-pulse/tools/browser-use/src/browser/cdpClient.js')
src=p.read_text(encoding='utf-8')
old="this.target=id ? {id} : tabs.find(t=>t.type==='page');"
new="if(id){ this.target = tabs.find(t=>t.id===id) || {id}; } else { this.target = tabs.find(t=>t.type==='page'); }"
print('old in src:', old in src)
if old in src:
    p.write_text(src.replace(old,new),encoding='utf-8')
    print('replaced')
