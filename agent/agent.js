// VPanel node agent: runs on every node VPS (needs root). Creates docker / lxc / kvm / hvm VPS.
const http=require('http'),{exec}=require('child_process');
const TOKEN=process.env.AGENT_TOKEN,PORT=+process.env.AGENT_PORT||8443,PUB=process.env.PUBLIC_IP||'',VG=process.env.LVM_VG||'';
const sh=c=>new Promise(r=>exec(c,{maxBuffer:5e7,shell:'/bin/bash'},(e,o,er)=>r({ok:!e,out:((o||'')+(er||'')).trim()})));
const q=s=>"'"+String(s).replace(/'/g,"'\\''")+"'";
const okName=/^[a-z0-9-]{2,40}$/,okPass=/^[A-Za-z0-9@#_.-]{6,40}$/;
const IMG={ubuntu:{docker:'ubuntu:22.04',lxc:'ubuntu:22.04',kvm:'https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img',v:'ubuntu22.04'},
 debian:{docker:'debian:12',lxc:'images:debian/12',kvm:'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2',v:'debian12'}};
const SSHSETUP=`apt-get update -y && apt-get install -y openssh-server && mkdir -p /run/sshd && sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin yes/;s/^#\\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config`;
async function create(v){
 if(!okName.test(v.name)||!okPass.test(v.pass))return{ok:false,out:'Invalid name/password'};
 const im=IMG[v.os]||IMG.ubuntu,P=+v.sshPort,ram=+v.ram,cpu=+v.cpu,disk=+v.disk;let r;
 if(v.type==='docker'){
  r=await sh(`docker run -d --name ${v.name} --memory ${ram}m --cpus ${cpu} -p ${P}:22 --restart unless-stopped ${im.docker} bash -c ${q(SSHSETUP+` && echo root:${v.pass} | chpasswd && exec /usr/sbin/sshd -D`)}`);
 }else if(v.type==='lxc'){
  r=await sh(`lxc launch ${im.lxc.includes(':')?im.lxc:'ubuntu:22.04'} ${v.name} -c limits.cpu=${cpu} -c limits.memory=${ram}MiB -d root,size=${disk}GiB && sleep 8 && lxc exec ${v.name} -- bash -c ${q(SSHSETUP+` && echo root:${v.pass} | chpasswd && systemctl restart ssh`)} && lxc config device add ${v.name} ssh proxy listen=tcp:0.0.0.0:${P} connect=tcp:127.0.0.1:22`);
 }else{ // kvm / hvm (hvm = full hardware virtualization, same QEMU/KVM engine with host CPU passthrough)
  const base=`/var/lib/vpanel/base-${v.os in IMG?v.os:'ubuntu'}.img`,dir='/var/lib/vpanel';let dsk=`${dir}/${v.name}.qcow2`,fmt='qcow2';
  const prep=VG?`lvcreate -y -L ${disk}G -n ${v.name} ${VG} && qemu-img convert -O raw ${base} /dev/${VG}/${v.name} && qemu-img resize -f raw /dev/${VG}/${v.name} ${disk}G`:`qemu-img create -f qcow2 -F qcow2 -b ${base} ${dsk} ${disk}G`;
  if(VG){dsk=`/dev/${VG}/${v.name}`;fmt='raw';}
  const ud=`#cloud-config\\nssh_pwauth: true\\ndisable_root: false\\nchpasswd:\\n  expire: false\\n  list: |\\n    root:${v.pass}\\nruncmd:\\n  - sed -i 's/^#\\\\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config\\n  - systemctl restart ssh sshd || true\\n`;
  r=await sh(`mkdir -p ${dir} && ([ -f ${base} ] || curl -L -o ${base} ${im.kvm}) && ${prep} && printf '${ud}' > ${dir}/${v.name}.ud && printf 'instance-id: ${v.name}\\nlocal-hostname: ${v.name}\\n' > ${dir}/${v.name}.md && cloud-localds ${dir}/${v.name}.iso ${dir}/${v.name}.ud ${dir}/${v.name}.md && virt-install --name ${v.name} --memory ${ram} --vcpus ${cpu}${v.type==='hvm'?' --cpu host-passthrough --hvm':''} --disk path=${dsk},format=${fmt} --disk path=${dir}/${v.name}.iso,device=cdrom --os-variant ${im.v} --import --network network=default --virt-type kvm --noautoconsole`);
  if(r.ok)sh(`for i in $(seq 1 40); do IP=$(virsh domifaddr ${v.name} | awk '/ipv4/{print $4}' | cut -d/ -f1); [ -n "$IP" ] && break; sleep 5; done; iptables -t nat -A PREROUTING -p tcp --dport ${P} -j DNAT --to $IP:22; iptables -I FORWARD -d $IP -p tcp --dport 22 -j ACCEPT`);
 }
 return{...r,ip:PUB};
}
async function action(v,a){const n=v.name;if(!okName.test(n))return{ok:false,out:'bad name'};
 const m={docker:{start:`docker start ${n}`,stop:`docker stop ${n}`,reboot:`docker restart ${n}`,delete:`docker rm -f ${n}`},
  lxc:{start:`lxc start ${n}`,stop:`lxc stop ${n}`,reboot:`lxc restart ${n}`,delete:`lxc delete -f ${n}`}};
 const k={start:`virsh start ${n}`,stop:`virsh shutdown ${n}`,reboot:`virsh reboot ${n}`,delete:`virsh destroy ${n}; virsh undefine ${n} --remove-all-storage; ${VG?`lvremove -y ${VG}/${n};`:''} iptables -t nat -S PREROUTING | grep -- "--dport ${v.sshPort} " | sed 's/^-A/-D/' | xargs -r -L1 iptables -t nat`};
 const c=(m[v.type]||k)[a];return c?sh(c):{ok:false,out:'Unsupported action for '+v.type+' (reinstall: delete and recreate)'};}
async function files(v,b){ // file manager for docker/lxc (exec into the VPS); KVM/HVM: use SSH/SFTP
 const n=v.name,p=b.path||'/';if(!okName.test(n))return{ok:false,out:'bad name'};
 const ex=c=>v.type==='docker'?`docker exec ${n} bash -c ${q(c)}`:v.type==='lxc'?`lxc exec ${n} -- bash -c ${q(c)}`:null;
 const cmd={list:`ls -la --group-directories-first ${q(p)}`,read:`head -c 200000 ${q(p)}`,write:`cat > ${q(p)} <<'VPEOF'\n${b.content||''}\nVPEOF`,mkdir:`mkdir -p ${q(p)}`,rm:`rm -rf ${q(p)}`}[b.op];
 if(!cmd)return{ok:false,out:'bad op'};const e=ex(cmd);return e?sh(e):{ok:false,out:'File manager works for Docker/LXC. For KVM/HVM use SFTP: sftp -P '+v.sshPort+' root@'+PUB};}
async function stats(v){const n=v.name;if(!okName.test(n))return{ok:false};
 const st=v.type==='docker'?await sh(`docker inspect -f '{{.State.Status}}' ${n}`):v.type==='lxc'?await sh(`lxc list ${n} -c s --format csv`):await sh(`virsh domstate ${n}`);
 let cpu=null,ram=null,disk=null;const ex=v.type==='docker'?c=>`docker exec ${n} bash -c ${q(c)}`:v.type==='lxc'?c=>`lxc exec ${n} -- bash -c ${q(c)}`:null;
 if(ex){const m=await sh(ex(`echo $(awk '{print $1}' /proc/loadavg) $(free | awk '/Mem/{printf "%d",$3*100/$2}') $(df / | awk 'NR==2{print $5}' | tr -d %)`));const p=m.out.split(' ');if(m.ok&&p.length===3){cpu=Math.min(100,Math.round(+p[0]*100/(v.cpu||1)));ram=+p[1];disk=+p[2];}}
 return{ok:true,state:st.out,cpu,ram,disk};}
async function password(v){if(!okName.test(v.name)||!okPass.test(v.password))return{ok:false,out:'invalid'};const c=`echo root:${v.password} | chpasswd`;
 return v.type==='docker'?sh(`docker exec ${v.name} bash -c ${q(c)}`):v.type==='lxc'?sh(`lxc exec ${v.name} -- bash -c ${q(c)}`):sh(`virsh set-user-password ${v.name} root ${v.password}`);}
http.createServer((req,res)=>{let d='';req.on('data',c=>d+=c);req.on('end',async()=>{
 const j=o=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(o));};
 if(req.headers.authorization!=='Bearer '+TOKEN){res.statusCode=401;return j({ok:false,out:'unauthorized'});}
 let b={};try{b=JSON.parse(d||'{}');}catch{}
 if(req.url==='/status')return j(await sh(`echo "$(nproc) CPU | $(free -m | awk '/Mem/{print $2}') MB RAM | docker:$(command -v docker >/dev/null&&echo yes||echo no) lxc:$(command -v lxc >/dev/null&&echo yes||echo no) kvm:$([ -e /dev/kvm ]&&echo yes||echo no)"`));
 if(req.url==='/create')return j(await create(b));
 if(req.url==='/action')return j(await action(b,b.action));
 if(req.url==='/stats')return j(await stats(b));
 if(req.url==='/password')return j(await password(b));
 if(req.url==='/files')return j(await files(b,b));
 j({ok:false,out:'not found'});});}).listen(PORT,()=>console.log('Agent on '+PORT));
