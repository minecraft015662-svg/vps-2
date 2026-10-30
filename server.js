// VPanel control plane (host on Render). Talks to node agents over HTTP.
const express=require('express'),crypto=require('crypto'),fs=require('fs');
const app=express();app.use(express.json());app.use(express.static(__dirname+'/public'));
const F=process.env.DATA_FILE||'./data.json';
let db=fs.existsSync(F)?JSON.parse(fs.readFileSync(F)):{users:[],nodes:[],vps:[],plans:[],sessions:{}};
const save=()=>fs.writeFileSync(F,JSON.stringify(db,null,1));
const hash=(p,s)=>crypto.scryptSync(p,s,32).toString('hex');
const rid=()=>crypto.randomBytes(6).toString('hex');
function addUser(u,p,role){const s=rid();db.users.push({u,s,h:hash(p,s),role});save();}
if(!db.users.find(x=>x.role==='admin'))addUser(process.env.ADMIN_USER||'admin',process.env.ADMIN_PASS||'admin123','admin');
if(process.env.LOCAL_NODE_TOKEN&&!db.nodes.find(n=>n.local)){db.nodes.push({id:rid(),name:'Local Node',host:'127.0.0.1',port:8443,token:process.env.LOCAL_NODE_TOKEN,types:['docker','lxc','kvm','hvm'],local:true,nextPort:20000});save();}
if(!db.plans)db.plans=[];if(!db.plans.length){db.plans=[{id:'p1',name:'Starter',ram:1024,cpu:1,disk:10,bw:1000},{id:'p2',name:'Standard',ram:2048,cpu:2,disk:40,bw:2000},{id:'p3',name:'Pro',ram:4096,cpu:4,disk:80,bw:4000}];save();}
const auth=(q,r,n)=>{const u=db.sessions[(q.headers.authorization||'').slice(7)];if(!u)return r.status(401).json({error:'Please login'});q.user=db.users.find(x=>x.u===u);n();};
const admin=(q,r,n)=>q.user.role==='admin'?n():r.status(403).json({error:'Admin only'});
const login=(u)=>{const t=rid()+rid();db.sessions[t]=u;save();return t;};
app.post('/api/login',(q,r)=>{const x=db.users.find(v=>v.u===q.body.user);if(!x||x.h!==hash(q.body.pass||'',x.s))return r.status(401).json({error:'Invalid login'});r.json({token:login(x.u),role:x.role,user:x.u});});
app.post('/api/register',(q,r)=>{const{user,pass}=q.body;if(!/^[a-zA-Z0-9_]{3,20}$/.test(user||'')||(pass||'').length<6)return r.status(400).json({error:'Bad username/password'});if(db.users.find(v=>v.u===user))return r.status(400).json({error:'User exists'});addUser(user,pass,'user');r.json({token:login(user),role:'user',user});});
async function agent(n,path,body){try{const x=await fetch(`http://${n.host}:${n.port}${path}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+n.token},body:JSON.stringify(body||{}),signal:AbortSignal.timeout(600000)});return await x.json();}catch(e){return{ok:false,out:'Node unreachable: '+e.message};}}
const mine=(q,id)=>db.vps.find(v=>v.id===id&&(q.user.role==='admin'||v.owner===q.user.u));
app.get('/api/me',auth,(q,r)=>r.json({user:q.user.u,role:q.user.role}));
app.get('/api/users',auth,admin,(q,r)=>r.json(db.users.map(u=>({u:u.u,role:u.role}))));
app.get('/api/nodes',auth,async(q,r)=>{const out=[];for(const n of db.nodes){const s=q.user.role==='admin'?await agent(n,'/status'):{};out.push({id:n.id,name:n.name,host:q.user.role==='admin'?n.host:undefined,types:n.types,local:n.local,online:!!s.ok,info:s.out,vps:db.vps.filter(v=>v.node===n.id).length});}r.json(out);});
app.post('/api/nodes',auth,admin,(q,r)=>{const{name,host,port,token,types}=q.body;if(!name||!host||!token)return r.status(400).json({error:'name, host, token required'});db.nodes.push({id:rid(),name,host,port:+port||8443,token,types:types||['docker','lxc','kvm','hvm'],nextPort:20000});save();r.json({ok:true});});
app.delete('/api/nodes/:id',auth,admin,(q,r)=>{if(db.vps.some(v=>v.node===q.params.id))return r.status(400).json({error:'Delete VPS on this node first'});db.nodes=db.nodes.filter(n=>n.id!==q.params.id);save();r.json({ok:true});});
app.get('/api/vps',auth,(q,r)=>r.json(db.vps.filter(v=>q.user.role==='admin'||v.owner===q.user.u)));
app.post('/api/vps',auth,admin,async(q,r)=>{const b=q.body,n=db.nodes.find(x=>x.id===b.node);if(!n)return r.status(400).json({error:'Pick a node'});const pl=db.plans.find(p=>p.id===b.plan);if(pl)Object.assign(b,{ram:pl.ram,cpu:pl.cpu,disk:pl.disk});
 if(!n.types.includes(b.type))return r.status(400).json({error:'Node does not support '+b.type});
 const pass=b.password||crypto.randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g,'a');
 const v={id:rid(),name:('vps-'+(b.name||rid())).toLowerCase().replace(/[^a-z0-9-]/g,'').slice(0,30),owner:b.owner||q.user.u,node:n.id,type:b.type,ram:+b.ram||1024,cpu:+b.cpu||1,disk:+b.disk||10,os:b.os||'ubuntu',pass,user:'root',ip:'',sshPort:n.nextPort++,status:'creating'};
 db.vps.push(v);save();
 const res=await agent(n,'/create',v);v.status=res.ok?'running':'error';v.ip=res.ip||n.host;v.log=res.out;save();r.json(v);});
app.get('/api/plans',auth,(q,r)=>r.json(db.plans));
app.post('/api/plans',auth,admin,(q,r)=>{const{name,ram,cpu,disk,bw}=q.body;db.plans.push({id:rid(),name,ram:+ram,cpu:+cpu,disk:+disk,bw:+bw});save();r.json({ok:true});});
app.delete('/api/plans/:id',auth,admin,(q,r)=>{db.plans=db.plans.filter(p=>p.id!==q.params.id);save();r.json({ok:true});});
const nodeOf=v=>db.nodes.find(x=>x.id===v.node);
app.get('/api/vps/:id/stats',auth,async(q,r)=>{const v=mine(q,q.params.id);if(!v)return r.status(404).json({error:'Not found'});r.json(await agent(nodeOf(v),'/stats',v));});
app.post('/api/vps/:id/password',auth,async(q,r)=>{const v=mine(q,q.params.id);if(!v)return r.status(404).json({error:'Not found'});const p=q.body.password;if(!/^[A-Za-z0-9@#_.-]{6,40}$/.test(p||''))return r.json({ok:false,out:'6-40 chars: letters, digits, @ # _ . -'});const res=await agent(nodeOf(v),'/password',{...v,password:p});if(res.ok){v.pass=p;save();}r.json(res);});
app.post('/api/vps/:id/reinstall',auth,async(q,r)=>{const v=mine(q,q.params.id);if(!v)return r.status(404).json({error:'Not found'});const n=nodeOf(v);await agent(n,'/action',{...v,action:'delete'});v.os=q.body.os||v.os;const res=await agent(n,'/create',v);v.status=res.ok?'running':'error';save();r.json(res);});
app.post('/api/vps/:id/:action',auth,async(q,r)=>{const v=mine(q,q.params.id);if(!v)return r.status(404).json({error:'Not found'});const a=q.params.action;
 if(!['start','stop','reboot','delete','reinstall'].includes(a))return r.status(400).json({error:'Bad action'});
 const n=db.nodes.find(x=>x.id===v.node);const res=await agent(n,'/action',{...v,action:a});
 if(a==='delete'&&res.ok)db.vps=db.vps.filter(x=>x.id!==v.id);else if(res.ok)v.status=a==='stop'?'stopped':'running';save();r.json(res);});
app.post('/api/vps/:id/files/:op',auth,async(q,r)=>{const v=mine(q,q.params.id);if(!v)return r.status(404).json({error:'Not found'});const n=db.nodes.find(x=>x.id===v.node);r.json(await agent(n,'/files',{...v,op:q.params.op,path:q.body.path,content:q.body.content}));});
app.listen(process.env.PORT||3000,()=>console.log('VPanel running'));
