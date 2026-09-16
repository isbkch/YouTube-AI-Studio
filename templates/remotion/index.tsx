import React from 'react';
import { AbsoluteFill, Composition, interpolate, registerRoot, useCurrentFrame, useVideoConfig } from 'remotion';
export type VisualProps = { template:string;parameters:{title:string;subtitle:string;nodes:string[];emphasis:number};brand:{background:string;foreground:string;accent:string;fontFamily:string};durationFrames:number;width:number;height:number;fps:number; }
const defaults:VisualProps={template:'Callout',parameters:{title:'Redundancy is not high availability.',subtitle:'WinTheCloud • Field notes on reliable systems',nodes:[],emphasis:-1},brand:{background:'#101b29',foreground:'#f2f4ed',accent:'#c8ef80',fontFamily:'Helvetica Neue'},durationFrames:180,width:1280,height:720,fps:30};
const label:React.CSSProperties={fontSize:16,fontWeight:600,letterSpacing:3,textTransform:'uppercase'};
export const Visual:React.FC<VisualProps>=(props)=>{
  const f=useCurrentFrame();const {width,height,fps}=useVideoConfig();const p=props.parameters,b=props.brand;
  const enter=interpolate(f,[0,Math.min(18,props.durationFrames/3)],[0,1],{extrapolateRight:'clamp'});
  return <AbsoluteFill style={{background:b.background,color:b.foreground,fontFamily:b.fontFamily,overflow:'hidden'}}>
    <div style={{width:1280,height:720,transform:`scale(${width/1280},${height/720})`,transformOrigin:'top left',position:'absolute'}}>
      <div style={{position:'absolute',inset:0,backgroundImage:`linear-gradient(${b.foreground}06 1px, transparent 1px),linear-gradient(90deg,${b.foreground}06 1px,transparent 1px)`,backgroundSize:'64px 64px'}}/>
      <div style={{position:'absolute',top:44,left:64,...label,color:b.accent}}>WinTheCloud <span style={{color:b.foreground,opacity:.45}}> / SYSTEM NOTES</span></div>
      <div style={{position:'absolute',top:44,right:64,...label,opacity:.35}}>PRODUCTION STUDY</div>
      {props.template==='ArchitectureFlow'?<>
        <div style={{position:'absolute',left:64,top:132,right:64,fontSize:p.title.length>65?42:50,fontWeight:600,letterSpacing:-1.7,opacity:enter,lineHeight:1.15}}>{p.title}</div>
        <div style={{position:'absolute',left:64,right:64,top:298,height:162,display:'flex',alignItems:'center',gap:0}}>
          {p.nodes.map((node,i)=><React.Fragment key={i}>
            {i>0&&<div style={{flex:'0 0 44px',height:2,background:`${b.accent}45`,position:'relative'}}><div style={{position:'absolute',width:7,height:7,borderRadius:5,background:b.accent,top:-3,left:((f/fps*.45+i*.17)%1)*37}}/></div>}
            <div style={{flex:1,minWidth:0,height:142,border:`1.5px solid ${i===p.emphasis?'#ef9988':b.accent+'65'}`,background:i===p.emphasis?'#35272b':'#172637',borderRadius:14,padding:'22px 16px',boxSizing:'border-box',opacity:enter,transform:`translateY(${(1-enter)*16}px)`}}>
              <div style={{...label,fontSize:13,color:i===p.emphasis?'#ef9988':b.accent,marginBottom:22}}>{i===p.emphasis?'Shared failure':`0${i+1} / SERVICE`}</div>
              <div style={{fontSize:p.nodes.length>4?22:27,lineHeight:1.12,fontWeight:500,overflowWrap:'anywhere'}}>{node}</div>
            </div>
          </React.Fragment>)}
        </div>
        <div style={{position:'absolute',left:64,right:64,top:518,fontSize:25,opacity:.62,lineHeight:1.4}}>{p.subtitle}</div>
      </>:props.template==='Placeholder'?<>
        <div style={{position:'absolute',left:70,top:145,width:550,fontSize:50,lineHeight:1.1,fontWeight:600}}>Why redundancy<br/>is not high<br/><span style={{color:b.accent}}>availability.</span></div>
        <div style={{position:'absolute',left:72,top:422,width:480,fontSize:23,lineHeight:1.45,opacity:.55}}>Synthetic A-roll placeholder<br/>Generated locally. No real person.</div>
        <div style={{position:'absolute',right:170,top:155,width:145,height:175,borderRadius:'48% 48% 44% 44%',background:'#355064'}}/>
        <div style={{position:'absolute',right:63,top:348,width:355,height:235,borderRadius:'46% 46% 10% 10%',background:'#263c50'}}/>
        <div style={{position:'absolute',right:120,top:568,width:250,height:12,borderRadius:10,background:b.accent,opacity:.6}}/>
      </>:<div style={{position:'absolute',inset:'175px 80px 120px 64px',display:'flex',flexDirection:'column',justifyContent:'center',opacity:enter,transform:`translateY(${(1-enter)*20}px)`}}>
        <div style={{width:55,height:4,background:b.accent,marginBottom:34}}/>
        <div style={{fontSize:p.title.length>70?58:72,lineHeight:1.09,fontWeight:550,letterSpacing:-2.2,maxWidth:1110,overflowWrap:'anywhere'}}>{p.title}</div>
        <div style={{fontSize:27,lineHeight:1.4,marginTop:28,opacity:.6,maxWidth:1080}}>{p.subtitle}</div>
      </div>}
      <div style={{position:'absolute',left:64,right:64,bottom:45,display:'flex',justifyContent:'space-between',...label,fontSize:12,color:b.foreground,opacity:.35}}><span>ENGINEERING, WITH INTENT.</span><span>{props.template==='Placeholder'?'DEMO / SYNTHETIC MEDIA':props.template==='ArchitectureFlow'?'ARCHITECTURE / FLOW':'IDEA / EXPLANATION'}</span></div>
      <div style={{position:'absolute',bottom:0,left:0,height:3,width:`${100*f/Math.max(1,props.durationFrames-1)}%`,background:b.accent,opacity:.55}}/>
    </div>
  </AbsoluteFill>;
};
const Root=()=> <Composition id="WinTheCloudVisual" component={Visual} defaultProps={defaults} durationInFrames={180} fps={30} width={1280} height={720} calculateMetadata={({props})=>({durationInFrames:props.durationFrames,fps:props.fps,width:props.width,height:props.height})}/>;
registerRoot(Root);
