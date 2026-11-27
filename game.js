import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const $=id=>document.getElementById(id);
const V=(x=0,y=0,z=0)=>new THREE.Vector3(x,y,z);
let scene,camera,renderer,world,player,playerLight,playerLightTarget,muzzle,rain,clock;
let targets=[],obstacles=[],enemies=[],targetNear=null;
let active=false,paused=false,dialogueLock=false,inventoryOpen=false,flashlightOn=true,running=false;
let stage=0,currentChapter=0,health=100,medkits=3,loadedAmmo=6,reserveAmmo=18;
let yaw=Math.PI/2,lastShot=0,hurtCooldown=0,lastSave=null,toastTimer=0;
let keys={},chapterGroup;
let audioContext=null, masterGain=null;
const materialCache=new Map();
function initAudio(){
  if(audioContext)return;try{
    audioContext=new (window.AudioContext||window.webkitAudioContext)();masterGain=audioContext.createGain();masterGain.gain.value=.18;masterGain.connect(audioContext.destination);
    const buffer=audioContext.createBuffer(1,audioContext.sampleRate*2,audioContext.sampleRate),data=buffer.getChannelData(0);for(let i=0;i<data.length;i++)data[i]=(Math.random()*2-1)*.19;
    const noise=audioContext.createBufferSource();noise.buffer=buffer;noise.loop=true;const filter=audioContext.createBiquadFilter();filter.type='lowpass';filter.frequency.value=720;const volume=audioContext.createGain();volume.gain.value=.34;noise.connect(filter).connect(volume).connect(masterGain);noise.start();
    const drone=audioContext.createOscillator(),droneGain=audioContext.createGain();drone.type='sine';drone.frequency.value=47;droneGain.gain.value=.035;drone.connect(droneGain).connect(masterGain);drone.start();
  }catch(e){console.warn('Audio unavailable',e);}
}
function playSfx(type){if(!audioContext||!masterGain)return;try{
  const now=audioContext.currentTime,osc=audioContext.createOscillator(),gain=audioContext.createGain();osc.connect(gain).connect(masterGain);
  if(type==='shot'){osc.type='sawtooth';osc.frequency.setValueAtTime(110,now);osc.frequency.exponentialRampToValueAtTime(40,now+.12);gain.gain.setValueAtTime(.32,now);gain.gain.exponentialRampToValueAtTime(.001,now+.23);osc.start(now);osc.stop(now+.24);}
  else if(type==='hit'){osc.type='triangle';osc.frequency.setValueAtTime(90,now);osc.frequency.exponentialRampToValueAtTime(28,now+.2);gain.gain.setValueAtTime(.3,now);gain.gain.exponentialRampToValueAtTime(.001,now+.2);osc.start(now);osc.stop(now+.21);}
  else{osc.type='sine';osc.frequency.setValueAtTime(type==='pickup'?640:390,now);osc.frequency.exponentialRampToValueAtTime(type==='pickup'?860:220,now+.14);gain.gain.setValueAtTime(.09,now);gain.gain.exponentialRampToValueAtTime(.001,now+.18);osc.start(now);osc.stop(now+.2);}
}catch{}}

function nearestInteractable(){
  let nearest=null,best=3.35;
  for(const t of targets){const d=t.userData;if(d.collected)continue;const enabled=d.pickupType||d.stage===stage;if(!enabled)continue;
    const distance=player.position.distanceTo(t.position);if(distance<best){best=distance;nearest=t;}}
  return nearest;
}
function updateInteractionUI(){
  targetNear=nearestInteractable();const prompt=$('interaction-prompt');
  if(targetNear&&!paused&&!dialogueLock&&!inventoryOpen){$('prompt-text').textContent=targetNear.userData.label;prompt.classList.remove('hidden');}
  else prompt.classList.add('hidden');
  const t=activeTarget();if(t){const d=player.position.distanceTo(t.position);$('distance').textContent=`${Math.max(0,Math.round(d))} M`;}
}
function updateTargetVisibility(){
  for(const t of targets){const isActive=t.userData.pickupType||t.userData.stage===stage;const vis=t.userData.visual;t.visible=true;vis.ring.visible=isActive;vis.beam.visible=isActive&&!t.userData.pickupType;vis.object.visible=isActive;}
}
function toggleInventory(){if(!active||paused||dialogueLock)return;inventoryOpen=!inventoryOpen;$('inventory-panel').classList.toggle('hidden',!inventoryOpen);if(inventoryOpen)renderInventory();}
function renderInventory(){
  const items=[['✚','FIRST AID','x '+medkits,medkits>0],['◉','REVOLVER',''+loadedAmmo+' / '+reserveAmmo,loadedAmmo+reserveAmmo>0],['⌁','FLASHLIGHT',flashlightOn?'POWER ON':'POWER OFF',true]];
  const clues=[];
  if(currentChapter>0||stage>0)clues.push('Clinic key');if(currentChapter>1||currentChapter===1&&stage>1)clues.push('Ceramic fuse');if(currentChapter>2||currentChapter===2&&stage>1)clues.push('Isha’s case file');if(currentChapter>3)clues.push('Eclipse clearance');if(currentChapter===4&&stage>1)clues.push('Eclipse sample');
  const grid=$('inventory-grid');grid.innerHTML='';for(const [icon,name,count,usable] of items){const el=document.createElement('button');el.className='inventory-slot';el.innerHTML=`<span class="slot-icon">${icon}</span><strong>${name}</strong><small>${count}</small>`;if(name==='FIRST AID'){el.onclick=()=>useMedkit();el.style.opacity=usable?'1':'.45';}grid.appendChild(el);}
  for(const clue of clues.slice(0,3)){const el=document.createElement('div');el.className='inventory-slot';el.innerHTML=`<span class="slot-icon">⌑</span><strong>${clue}</strong><small>CASE EVIDENCE</small>`;grid.appendChild(el);}
}
function useMedkit(){if(!medkits||health>=100){showToast(!medkits?'NO FIRST AID REMAINING':'VITALS ALREADY STABLE');return;}medkits--;health=Math.min(100,health+45);updateObjectiveUI();autoSave();playSfx('pickup');showToast('FIRST AID USED · VITALS RESTORED');renderInventory();}
function togglePause(){if(!active)return;paused=!paused;$('pause-panel').classList.toggle('hidden',!paused);}
function reload(){if(!active||paused||loadedAmmo===6||reserveAmmo<=0)return;const amount=Math.min(6-loadedAmmo,reserveAmmo);reserveAmmo-=amount;loadedAmmo+=amount;updateObjectiveUI();playSfx('pickup');showToast('REVOLVER RELOADED');}
function fire(){
  if(!active||paused||dialogueLock||inventoryOpen||performance.now()-lastShot<340)return;
  lastShot=performance.now();if(loadedAmmo<=0){playSfx('hit');showToast(reserveAmmo?'PRESS R TO RELOAD':'NO AMMUNITION');return;}
  loadedAmmo--;updateObjectiveUI();playSfx('shot');muzzle.visible=true;setTimeout(()=>{if(muzzle)muzzle.visible=false;},65);
  const origin=player.position.clone().add(V(0,1.45,0));const facing=V(Math.sin(yaw),0,-Math.cos(yaw)).normalize();let victim=null,victimDistance=Infinity;
  for(const e of enemies){const to=e.position.clone().add(V(0,1.1,0)).sub(origin),distance=to.length(),angle=facing.dot(to.clone().normalize());if(distance<23&&angle>.84&&distance<victimDistance){victim=e;victimDistance=distance;}}
  if(victim){victim.userData.hp--;victim.userData.hitFlash=.14;victim.userData.body.material.emissive.setHex(0x5a1710);playSfx('hit');if(victim.userData.hp<=0){const pos=victim.position.clone();world.remove(victim);enemies=enemies.filter(e=>e!==victim);showToast('HOSTILE NEUTRALIZED');if(Math.random()<.48)addPickup(pos.x,pos.z,'ammo',4);}}
  else showToast('THE SHOT DISAPPEARS INTO THE RAIN',1000);
}
function damage(amount){if(hurtCooldown>0||!active)return;hurtCooldown=1.1;health=Math.max(0,health-amount);updateObjectiveUI();const flash=$('damage-flash');flash.style.opacity='.9';setTimeout(()=>flash.style.opacity='0',180);playSfx('hit');
  if(health<=0){showToast('YOU HAVE BEEN FOUND',1800);setTimeout(()=>{health=55;player.position.set(-21,0,3);player.userData.velocity.set(0,0,0);buildChapter(currentChapter);stage=lastSave?.chapter===currentChapter?(lastSave.stage||0):0;updateTargetVisibility();updateObjectiveUI();autoSave();showDialogue(['Arjun: I can still hear her. I have to keep moving.']);},1200);}
}
function updateEnemies(dt,time){
  for(const e of enemies){const u=e.userData,to=player.position.clone().sub(e.position);to.y=0;const dist=to.length();u.timer-=dt;u.attack-=dt;
    const alert=dist<10.5;u.mode=alert?'hunt':'wander';let dir=V();
    if(alert){dir=to.normalize();if(dist<1.6&&u.attack<=0){u.attack=1.65;damage(u.type==='warden'?19:12);}}
    else{if(u.timer<=0){u.timer=2+Math.random()*3;u.wander=V(Math.random()-.5,0,Math.random()-.5).normalize();}dir=u.wander||V();}
    const speed=alert?(u.type==='warden'?1.7:1.35):.32; e.position.addScaledVector(dir,speed*dt);
    e.position.x=THREE.MathUtils.clamp(e.position.x,-23,23);e.position.z=THREE.MathUtils.clamp(e.position.z,-8.7,8.7);
    if(dir.lengthSq()>.1)e.rotation.y=Math.atan2(dir.x,-dir.z);
    const phase=time*4+u.phase;e.position.y=Math.sin(phase)*.035;
    const limbs=u.limbs;limbs.arm1.rotation.x=Math.sin(phase)*.28;limbs.arm2.rotation.x=-Math.sin(phase)*.32;limbs.leg1.rotation.x=-Math.sin(phase)*.22;limbs.leg2.rotation.x=Math.sin(phase)*.22;
    if(u.hitFlash>0){u.hitFlash-=dt;if(u.hitFlash<=0)u.body.material.emissive.setHex(0x000000);}
  }
}

let touchMove=V(), touchRun=false;
function movePlayer(dt,time){
  const forward=V(Math.sin(yaw),0,-Math.cos(yaw)),right=V(Math.cos(yaw),0,Math.sin(yaw));
  const mx=(keys.KeyD?1:0)-(keys.KeyA?1:0)+(touchMove.x||0),my=(keys.KeyW?1:0)-(keys.KeyS?1:0)+(touchMove.y||0);
  const dir=right.multiplyScalar(mx).add(forward.multiplyScalar(my));if(dir.lengthSq()>1)dir.normalize();
  running=(keys.ShiftLeft||keys.ShiftRight||touchRun)&&dir.lengthSq()>.1;
  const speed=running?5.6:3.05,vel=player.userData.velocity;const desired=dir.clone().multiplyScalar(speed);
  vel.lerp(desired,1-Math.exp(-11*dt));
  const old=player.position.clone();player.position.x+=vel.x*dt;player.position.z+=vel.z*dt;
  player.position.x=THREE.MathUtils.clamp(player.position.x,-24,24);player.position.z=THREE.MathUtils.clamp(player.position.z,-9.2,9.2);
  for(const o of obstacles){const dx=player.position.x-o.x,dz=player.position.z-o.z,dist=Math.hypot(dx,dz);if(dist<o.r+.5){player.position.x=old.x;player.position.z=old.z;break;}}
  if(dir.lengthSq()>.025){player.rotation.y=Math.atan2(dir.x,-dir.z);player.userData.walk+=dt*(running?12:8);const phase=player.userData.walk;player.userData.legL.rotation.x=Math.sin(phase)*.55;player.userData.legR.rotation.x=-Math.sin(phase)*.55;player.userData.armL.rotation.x=-Math.sin(phase)*.38;player.userData.armR.rotation.x=Math.sin(phase)*.34;}
  else{player.userData.velocity.multiplyScalar(Math.exp(-4*dt));for(const limb of [player.userData.legL,player.userData.legR,player.userData.armL,player.userData.armR])limb.rotation.x=THREE.MathUtils.damp(limb.rotation.x,0,8,dt);}
  const camForward=V(Math.sin(yaw),0,-Math.cos(yaw));const wanted=player.position.clone().addScaledVector(camForward,-6.8).add(V(0,3.2,0));camera.position.lerp(wanted,1-Math.exp(-5.4*dt));const look=player.position.clone().addScaledVector(camForward,1.35).add(V(0,1.28,0));camera.lookAt(look);
  playerLight.visible=flashlightOn;playerLight.intensity=flashlightOn?68:0;
  hurtCooldown=Math.max(0,hurtCooldown-dt);
}

const chapters=[
 {name:'THE SILENT TOWN',quote:'“The rain has a way of washing away the footprints. Not the voices.”',objectives:[['Find a way into the clinic','The road ends at the old dispensary.'],['Restore power to the clinic','The fuse box is somewhere behind the market.'],['Reach the hill road','Something followed you out of the dark.']]},
 {name:'THE EMPTY WARD',quote:'“Every bed is made. Every chart ends on the same night.”',objectives:[['Search the triage ward','Look for a record of Isha’s admission.'],['Find the ward key','The generator room is locked from the inside.'],['Descend below the hospital','The records point beneath the old wing.']]},
 {name:'BELOW THE SURFACE',quote:'“The walls are newer than the town. They were built to keep something in.”',objectives:[['Trace the service tunnel','Follow the cable markings through the dark.'],['Open the containment gate','The backup relay needs a manual reset.'],['Find the extraction lift','The elevator is still drawing power.']]},
 {name:'THE LAST CALL',quote:'“The station logged the evacuation. No one logged the return.”',objectives:[['Enter the police station','The emergency channel is still transmitting.'],['Recover the incident file','Find the duty officer’s sealed archive.'],['Unlock the evidence room','The final key is held in the lockup.']]},
 {name:'THE SANCTUARY',quote:'“They called it a cure. They never asked what it wanted.”',objectives:[['Cross the research wing','The signal is coming from the central chamber.'],['Secure the Eclipse sample','Do not let it reach the rainwater.'],['Reach Isha','The sealed door is opening from the other side.']]}
];
const objectiveSpots=[[-14,1],[-1,1],[15,1]];
const palette=[0x343b37,0x414345,0x343c42,0x403b37,0x3e3933];

function init(){
  const canvas=$('world');scene=new THREE.Scene();scene.background=new THREE.Color(0x090d10);scene.fog=new THREE.FogExp2(0x10191b,.032);
  camera=new THREE.PerspectiveCamera(54,innerWidth/innerHeight,.1,180);
  renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:'high-performance'});
  const gl=renderer.getContext(),debugInfo=gl.getExtension('WEBGL_debug_renderer_info'),gpuName=debugInfo?gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL):'';
  const resolutionCap=/swiftshader|llvmpipe|softpipe/i.test(gpuName)?.55:1;
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,resolutionCap));renderer.setSize(innerWidth,innerHeight);renderer.shadowMap.enabled=false;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.12;
  world=new THREE.Group();scene.add(world);scene.add(new THREE.HemisphereLight(0x9db6c0,0x1b1715,1.05));
  player=makePlayer();scene.add(player);
  playerLight=new THREE.SpotLight(0xd9e8e7,42,24,Math.PI/7,0.42,1);
  playerLight.castShadow=false;playerLightTarget=new THREE.Object3D();
  scene.add(playerLight,playerLightTarget);playerLight.target=playerLightTarget;
  muzzle=new THREE.Mesh(new THREE.SphereGeometry(.12,8,6),new THREE.MeshBasicMaterial({color:0xff9b54}));muzzle.visible=false;scene.add(muzzle);
  makeRain();clock=new THREE.Clock();bindControls();resize();window.addEventListener('resize',resize);requestAnimationFrame(frame);
  try{lastSave=JSON.parse(localStorage.getItem('last-sanctuary-save')||'null');}catch{lastSave=null;}
  if(lastSave&&Number.isInteger(lastSave.chapter))$('continue-button').classList.remove('hidden');
  $('loading-screen').classList.add('hidden');updateObjectiveUI();
}
function makeMat(color,roughness=.9,emissive=0){const key=`${color}:${roughness}:${emissive}`;if(!materialCache.has(key))materialCache.set(key,new THREE.MeshStandardMaterial({color,roughness,metalness:.05,emissive,emissiveIntensity:emissive?1:0}));return materialCache.get(key);}
function box(parent,x,y,z,sx,sy,sz,mat,cast=true){const m=new THREE.Mesh(new THREE.BoxGeometry(sx,sy,sz),mat);m.position.set(x,y,z);m.castShadow=cast;m.receiveShadow=true;parent.add(m);return m;}
function makePlayer(){
  const g=new THREE.Group(),coat=makeMat(0x252d2e),skin=makeMat(0x9a745b),dark=makeMat(0x111618),pants=makeMat(0x202527);
  const torso=box(g,0,1.05,0,.62,.82,.34,coat);torso.castShadow=true;
  const head=new THREE.Mesh(new THREE.SphereGeometry(.19,12,10),skin);head.position.set(0,1.62,0);head.castShadow=true;g.add(head);
  box(g,0,1.39,-.02,.37,.09,.38,dark);
  const armL=box(g,-.39,1.08,0,.16,.62,.18,coat),armR=box(g,.39,1.08,0,.16,.62,.18,coat);
  const legL=box(g,-.17,.43,0,.22,.78,.26,pants),legR=box(g,.17,.43,0,.22,.78,.26,pants);
  g.position.set(-21,0,3);g.userData={velocity:V(),walk:0,armL,armR,legL,legR};return g;
}
function makeRain(){
  const count=1050,positions=new Float32Array(count*3);for(let i=0;i<count;i++){positions[i*3]=(Math.random()-.5)*56;positions[i*3+1]=Math.random()*22;positions[i*3+2]=(Math.random()-.5)*44;}
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(positions,3));const mat=new THREE.PointsMaterial({color:0x9fb7bd,size:.055,transparent:true,opacity:.38,depthWrite:false});rain=new THREE.Points(geo,mat);scene.add(rain);
}
function resize(){if(!renderer)return;camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);}
function addBuilding(x,z,w,d,h,seed){
  const base=makeMat(palette[currentChapter]);const shell=box(world,x,h/2,z,w,h,d,base);box(world,x,h+.13,z,w+.18,.26,d+.18,makeMat(0x252a29));
  box(world,x,h*.49,z-d/2-.035,w*.24,h*.35,.08,makeMat(0x151b1c));
  const windowMat=makeMat(seed%2?0x374947:0x493c31,.5,seed%2?0x0b2825:0x211108);
  for(const side of [-1,1])for(let i=0;i<2;i++){
    const wx=x+(i-.5)*w*.48,wz=z+side*(d/2+.045);box(world,wx,h*.68,wz,w*.2,h*.2,.07,windowMat,false);
    if(seed%3===0)box(world,wx,h*.68,wz+side*.045,w*.2,h*.2,.04,makeMat(0x756041,0.5,0x211108),false);
  }
  if(Math.abs(z)>6.7)obstacles.push({x,z,r:Math.max(w,d)*.38});return shell;
}
function buildEnvironment(){
  const floor=box(world,0,-.28,0,120,.5,100,makeMat(0x151b1b),false);floor.receiveShadow=true;
  box(world,0,-.015,0,100,.08,5.3,makeMat(0x202322),false);
  for(let x=-45;x<50;x+=5)box(world,x,.035,0,.1,.015,4.7,makeMat(0x46443d),false);
  const sideMat=makeMat(0x202725),roadside=box(world,0,.01,4.5,100,.11,.4,sideMat,false);box(world,0,.01,-4.5,100,.11,.4,sideMat,false);
  // Silhouetted facades and scattered roadside ruins keep the play lane clear.
  for(let i=0;i<16;i++){
    const x=-42+i*5.7,w=3.1+(i%3)*.65,d=2.2+(i%2)*.7,h=3.7+(i%4)*.85;
    addBuilding(x,7.1,w,d,h,i);addBuilding(x+1.6,-7.2,w*.78,d,h*.8,i+1);
  }
  const poleMat=makeMat(0x222726,.8,.06);
  for(let x=-34;x<42;x+=13){
    const pole=box(world,x,2.4,-5.3,.12,4.8,.12,poleMat);box(world,x,4.75,-5.3,1.2,.12,.12,poleMat);
    const lamp=box(world,x,4.35,-5.25,.32,.16,.28,makeMat(0xffbd7e,.5,0x8a5830),false);
  }
  // Puddles catch the sparse light without adding expensive reflection passes.
  for(let i=0;i<24;i++){
    const puddle=new THREE.Mesh(new THREE.CircleGeometry(.35+Math.random()*.8,14),new THREE.MeshStandardMaterial({color:0x344044,roughness:.2,metalness:.45,transparent:true,opacity:.48}));
    puddle.rotation.x=-Math.PI/2;puddle.position.set(Math.random()*78-39,.045,Math.random()*7-3.5);world.add(puddle);
  }
  const sign=box(world,-15,2,-5.1,3.2,1.25,.12,makeMat(0x282522));
  box(world,-15,3,-4.6,.22,.22,.12,makeMat(0xb24d3c,.5,0x69251e),false);
}
function addTarget(x,z,label,opts={}){
  const root=new THREE.Group();root.position.set(x,0,z);const color=opts.pickupType==='ammo'?0x9cad85:opts.pickupType==='medkit'?0xb75c50:0xd9a66c;
  const base=new THREE.Mesh(new THREE.CylinderGeometry(.42,.52,.11,18),makeMat(0x383936));base.position.y=.07;root.add(base);
  const object=new THREE.Mesh(new THREE.OctahedronGeometry(opts.pickupType?.34:.24,0),new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:1.6,roughness:.35}));object.position.y=opts.pickupType?1:.75;root.add(object);
  const ring=new THREE.Mesh(new THREE.TorusGeometry(.53,.025,5,28),new THREE.MeshBasicMaterial({color,transparent:true,opacity:.75}));ring.rotation.x=Math.PI/2;ring.position.y=.15;root.add(ring);
  const beam=new THREE.Mesh(new THREE.CylinderGeometry(.025,.34,2.8,10,1,true),new THREE.MeshBasicMaterial({color,transparent:true,opacity:.12,side:THREE.DoubleSide,depthWrite:false}));beam.position.y=1.65;root.add(beam);
  world.add(root);
  root.userData={label,stage:opts.stage,pickupType:opts.pickupType,collected:false,visual:{ring,beam,object}};targets.push(root);return root;
}
function spawnEnemy(x,z,type='stalker'){
  const g=new THREE.Group(),flesh=makeMat(type==='warden'?0x433736:0x333534),cloth=makeMat(0x171b1b),eyeMat=new THREE.MeshBasicMaterial({color:0xd8724f});
  const body=box(g,0,1.12,0,.58,.86,.34,flesh),head=new THREE.Mesh(new THREE.SphereGeometry(.23,12,10),flesh);head.position.y=1.72;g.add(head);
  const arm1=box(g,-.4,1.1,0,.16,.68,.18,cloth),arm2=box(g,.4,1.1,0,.16,.68,.18,cloth),leg1=box(g,-.17,.43,0,.22,.78,.26,cloth),leg2=box(g,.17,.43,0,.22,.78,.26,cloth);
  for(const xeye of [-.09,.09]){const eye=new THREE.Mesh(new THREE.SphereGeometry(.035,8,6),eyeMat);eye.position.set(xeye,1.76,-.205);g.add(eye);}
  g.position.set(x,0,z);g.userData={hp:type==='warden'?4:2,type,body,limbs:{arm1,arm2,leg1,leg2},timer:Math.random()*2,attack:1,phase:Math.random()*6,wander:V(1,0,0),hitFlash:0};world.add(g);enemies.push(g);return g;
}
function mergeEnvironmentBoxes(){
  world.updateMatrixWorld(true);const batches=new Map(),boxes=[];
  for(const mesh of world.children){if(!mesh.isMesh||!mesh.geometry?.type?.startsWith('BoxGeometry')||Array.isArray(mesh.material))continue;
    const source=mesh.material,key=[source.roughness,source.metalness,source.emissive.getHex(),source.emissiveIntensity].join(':');
    let batch=batches.get(key);if(!batch){batch={roughness:source.roughness,metalness:source.metalness,emissive:source.emissive.getHex(),emissiveIntensity:source.emissiveIntensity,positions:[],normals:[],colors:[],indices:[]};batches.set(key,batch);}
    mesh.updateMatrix();const normalMatrix=new THREE.Matrix3().getNormalMatrix(mesh.matrix);const pos=mesh.geometry.attributes.position,norm=mesh.geometry.attributes.normal,index=mesh.geometry.index,offset=batch.positions.length/3,color=source.color;
    for(let i=0;i<pos.count;i++){const p=V().fromBufferAttribute(pos,i).applyMatrix4(mesh.matrix),n=V().fromBufferAttribute(norm,i).applyMatrix3(normalMatrix).normalize();batch.positions.push(p.x,p.y,p.z);batch.normals.push(n.x,n.y,n.z);batch.colors.push(color.r,color.g,color.b);}
    for(let i=0;i<index.count;i++)batch.indices.push(index.getX(i)+offset);
    boxes.push(mesh);
  }
  for(const mesh of boxes){world.remove(mesh);mesh.geometry.dispose();}
  for(const batch of batches.values()){
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(batch.positions,3));geometry.setAttribute('normal',new THREE.Float32BufferAttribute(batch.normals,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(batch.colors,3));geometry.setIndex(batch.indices);geometry.computeBoundingSphere();
    const material=new THREE.MeshStandardMaterial({color:0xffffff,vertexColors:true,roughness:batch.roughness,metalness:batch.metalness,emissive:batch.emissive,emissiveIntensity:batch.emissiveIntensity});world.add(new THREE.Mesh(geometry,material));
  }
}
function buildChapter(index){
  currentChapter=index;stage=0;targets=[];obstacles=[];enemies=[];world.traverse(o=>{if(o.isMesh)o.geometry?.dispose();});world.clear();world.fog=null;
  scene.fog=new THREE.FogExp2(index<2?0x11191b:0x131719,.032+index*.003);buildEnvironment();mergeEnvironmentBoxes();player.position.set(-21,0,3);player.userData.velocity.set(0,0,0);yaw=Math.PI/2;
  const points=objectiveSpots;for(let i=0;i<3;i++){const [x,z]=points[i];addTarget(x,z,chapters[index].objectives[i][0],{stage:i});}
  // Supplies are optional and placed beside, not on, the critical route.
  addTarget(-8,-2,'Collect ammunition',{pickupType:'ammo'});addTarget(8,2,'First aid supplies',{pickupType:'medkit'});
  if(index===0){spawnEnemy(-3,6,'stalker');spawnEnemy(10,-6,'stalker');}
  else if(index===1){spawnEnemy(-4,5,'stalker');spawnEnemy(11,6,'warden');}
  else{spawnEnemy(-4,-6,'stalker');spawnEnemy(8,6,'stalker');spawnEnemy(18,5,'warden');}
  updateTargetVisibility();updateObjectiveUI();
}
function activeTarget(){return targets.find(t=>!t.userData.pickupType&&t.userData.stage===stage)||null;}
function updateObjectiveUI(){
  const data=chapters[Math.min(currentChapter,4)];if(!data)return;
  const item=data.objectives[Math.min(stage,2)];$('chapter-name').textContent=`CHAPTER ${String(currentChapter+1).padStart(2,'0')}`;$('chapter-place').textContent=data.name;
  $('objective-title').textContent=item[0];$('objective-detail').textContent=item[1];$('objective-count').textContent=`${String(stage+1).padStart(2,'0')} / 03`;
  $('health-value').textContent=Math.ceil(health);$('health-fill').style.width=`${health}%`;$('status-text').textContent=health>65?'STABLE · ADRENALINE ACTIVE':health>30?'WOUNDED · KEEP MOVING':'CRITICAL · USE FIRST AID';
  $('ammo-loaded').textContent=String(loadedAmmo).padStart(2,'0');$('ammo-reserve').textContent=String(reserveAmmo).padStart(2,'0');$('inventory-count').textContent=String(medkits).padStart(2,'0');$('light-state').textContent=flashlightOn?'ON':'OFF';
}
function autoSave(){lastSave={chapter:currentChapter,stage,health,medkits,loadedAmmo,reserveAmmo};try{localStorage.setItem('last-sanctuary-save',JSON.stringify(lastSave));}catch{} }
function showToast(message,duration=2100){const el=$('toast');el.textContent=message;el.classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.add('hidden'),duration);}
let dialogueQueue=[];
function showDialogue(lines){dialogueQueue=Array.isArray(lines)?[...lines]:[String(lines)];dialogueLock=true;advanceDialogue();}
function advanceDialogue(){if(!dialogueQueue.length){dialogueLock=false;$('dialogue').classList.add('hidden');return;}$('dialogue-text').textContent=dialogueQueue.shift();$('dialogue').classList.remove('hidden');}
function interact(){
  if(!active||paused)return;if(dialogueLock){advanceDialogue();return;}if(inventoryOpen){toggleInventory();return;}
  const t=nearestInteractable();if(!t)return;const d=t.userData;
  if(d.pickupType){d.collected=true;t.visible=false;if(d.pickupType==='ammo'){reserveAmmo+=4;showToast('AMMUNITION RECOVERED · +4 ROUNDS');}else if(d.pickupType==='medkit'){medkits++;showToast('FIRST AID RECOVERED');}updateObjectiveUI();autoSave();playSfx('pickup');return;}
  const index=d.stage;if(index!==stage)return;
  if(index===1&&loadedAmmo===0&&reserveAmmo===0){showToast('THE LOCK NEEDS A CHARGE — SEARCH FOR AMMUNITION');return;}
  stage++;
  if(stage>=3){
    if(currentChapter===4){autoSave();active=false;$('hud').classList.add('hidden');$('ending-screen').classList.remove('hidden');$('ending-copy').textContent='Isha is on the other side of the glass. The voice answering her is not human.';return;}
    const next=currentChapter+1;autoSave();$('chapter-card').classList.remove('hidden');$('card-number').textContent=String(next+1).padStart(2,'0');$('card-title').textContent=chapters[next].name;$('card-quote').textContent=chapters[next].quote;
    paused=true;setTimeout(()=>{$('chapter-card').classList.add('hidden');paused=false;buildChapter(next);autoSave();showDialogue(chapterIntro(next));},2800);return;
  }
  updateTargetVisibility();updateObjectiveUI();autoSave();playSfx('pickup');
  const dialogues=[
    ['Arjun: The clinic is running on a backup line. I need to find where it comes in.'],
    ['Arjun: This is not a hospital chart. It is an intake manifest.','Arjun: Isha was transferred below the ward.'],
    ['Arjun: These tunnels were never on the town plans.','Arjun: Someone built an entire facility under Devghar.'],
    ['Arjun: The station has a recording from the night she vanished.','Arjun: I can hear the same signal in the background.'],
    ['Arjun: Isha? I’m here.','Unknown voice: You should not have come back.']
  ];showDialogue(dialogues[currentChapter]);
}
function chapterIntro(index){return [
 'Arjun: The town is empty, but the power is still on. That means someone left in a hurry.',
 'Arjun: The hospital records say Isha was here. The ward is silent now.',
 'Arjun: There is a complex beneath the hospital. I can hear machinery running.',
 'Arjun: The police sealed the district before the evacuation. I need the evidence room.',
 'Arjun: The signal ends at the research wing. Whatever happened here began with Project Eclipse.'
][index];}
function saveCheckpoint(){autoSave();$('save-message').textContent='CHECKPOINT SAVED · CHAPTER '+String(currentChapter+1).padStart(2,'0');showToast('CHECKPOINT SAVED');}
function bindControls(){
  $('start-button').addEventListener('click',()=>startGame(false));$('continue-button').addEventListener('click',()=>startGame(true));$('restart-button').addEventListener('click',()=>{try{localStorage.removeItem('last-sanctuary-save');}catch{}lastSave=null;$('continue-button').classList.add('hidden');$('ending-screen').classList.add('hidden');$('title-screen').classList.remove('hidden');});
  $('pause-button').addEventListener('click',togglePause);$('resume-button').addEventListener('click',togglePause);$('save-button').addEventListener('click',saveCheckpoint);
  $('inventory-button').addEventListener('click',toggleInventory);$('flashlight-button').addEventListener('click',()=>{flashlightOn=!flashlightOn;updateObjectiveUI();playSfx('pickup');});
  window.addEventListener('keydown',e=>{
    if(['Tab','Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))e.preventDefault();keys[e.code]=true;
    if(e.repeat)return;
    if(e.code==='KeyE'||e.code==='Enter'){interact();}
    else if(e.code==='Tab'){toggleInventory();}
    else if(e.code==='Escape'){if(inventoryOpen)toggleInventory();else togglePause();}
    else if(e.code==='KeyF'){flashlightOn=!flashlightOn;updateObjectiveUI();playSfx('pickup');}
    else if(e.code==='KeyR')reload();
  });
  window.addEventListener('keyup',e=>{keys[e.code]=false;});window.addEventListener('blur',()=>{keys={};touchRun=false;});
  const canvas=$('world');let dragging=false,lastX=0;
  canvas.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse'&&e.button===2){dragging=true;lastX=e.clientX;canvas.setPointerCapture(e.pointerId);e.preventDefault();return;}if(e.pointerType==='mouse'&&e.button===0){fire();}});
  canvas.addEventListener('pointermove',e=>{if(dragging){yaw-=((e.clientX-lastX)||0)*.006;lastX=e.clientX;}});canvas.addEventListener('pointerup',()=>dragging=false);canvas.addEventListener('contextmenu',e=>e.preventDefault());
  $('mobile-interact').addEventListener('click',interact);$('mobile-fire').addEventListener('click',fire);$('mobile-run').addEventListener('pointerdown',()=>touchRun=true);$('mobile-run').addEventListener('pointerup',()=>touchRun=false);$('mobile-run').addEventListener('pointerleave',()=>touchRun=false);
  const stick=$('touch-stick'),knob=stick.querySelector('.stick-knob');let stickId=null;
  stick.addEventListener('pointerdown',e=>{stickId=e.pointerId;stick.setPointerCapture(stickId);updateStick(e);});
  stick.addEventListener('pointermove',e=>{if(e.pointerId===stickId)updateStick(e);});
  const release=()=>{stickId=null;touchMove=V();knob.style.transform='translate(0,0)';};stick.addEventListener('pointerup',release);stick.addEventListener('pointercancel',release);
  function updateStick(e){const r=stick.getBoundingClientRect(),dx=e.clientX-(r.left+r.width/2),dy=e.clientY-(r.top+r.height/2),limit=r.width*.34,len=Math.hypot(dx,dy),scale=len>limit?limit/len:1;touchMove.set(dx*scale/limit,-dy*scale/limit);knob.style.transform=`translate(${dx*scale}px,${dy*scale}px)`;}
}
function frame(){
  requestAnimationFrame(frame);const dt=Math.min(clock.getDelta(),.045),time=clock.elapsedTime;
  if(active&&!paused&&!dialogueLock&&!inventoryOpen){movePlayer(dt,time);updateEnemies(dt,time);}
  if(rain){const a=rain.geometry.attributes.position;for(let i=0;i<a.count;i++){let y=a.getY(i)-dt*19;if(y<0)y=20+Math.random()*5;a.setY(i,y);}a.needsUpdate=true;rain.position.x=player?.position.x||0;rain.position.z=player?.position.z||0;}
  if(player){const forward=V(Math.sin(yaw),0,-Math.cos(yaw));playerLight.position.copy(player.position).add(V(0,1.52,0));playerLightTarget.position.copy(player.position).addScaledVector(forward,12).add(V(0,.15,0));muzzle.position.copy(player.position).add(V(0,1.3,0)).addScaledVector(forward,.48);}
  for(const t of targets){if(!t.userData.collected)t.children[1].rotation.y=time*.8;}
  if(active&&!paused&&!dialogueLock&&!inventoryOpen)updateInteractionUI();
  renderer.render(scene,camera);
}
init();
function startGame(continuing=false){
  initAudio();if(audioContext?.state==='suspended')audioContext.resume();
  $('title-screen').classList.add('hidden');$('ending-screen').classList.add('hidden');$('hud').classList.remove('hidden');active=true;paused=false;inventoryOpen=false;
  if(continuing&&lastSave){currentChapter=Math.max(0,Math.min(4,lastSave.chapter|0));stage=Math.max(0,Math.min(2,lastSave.stage|0));health=lastSave.health||100;medkits=lastSave.medkits??3;loadedAmmo=lastSave.loadedAmmo??6;reserveAmmo=lastSave.reserveAmmo??18;buildChapter(currentChapter);stage=Math.max(0,Math.min(2,lastSave.stage|0));updateTargetVisibility();updateObjectiveUI();showDialogue(['Arjun: The rain has not stopped. I should keep moving.']);}
  else{currentChapter=0;stage=0;health=100;medkits=3;loadedAmmo=6;reserveAmmo=18;buildChapter(0);autoSave();showDialogue(['Arjun: Devghar. Three hours since the last call.','Arjun: Isha, if you can hear this, I’m coming.']);}
}

