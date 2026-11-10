import pathlib, re
p=pathlib.Path('E:/Users/maximus/Documents/GitHub/uganda-art-pulse/tools/browser-use/src/browser/cdpClient.js')
src=p.read_text(encoding='utf-8')
pat = r'this\.target=id \? \{id\} : tabs\.find\(t=>t\.type===\"page\"\);'
repl = 'if(id){ this.target = tabs.find(t=>t.id===id) || {id}; } else { this.target = tabs.find(t=>t.type==="page"); }'
if re.search(pat, src):
    src=re.sub(pat, repl, src)
    p.write_text(src,encoding='utf-8')
    print('replaced')
else:
    print('pattern not found')
