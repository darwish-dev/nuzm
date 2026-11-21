#!/usr/bin/env python3
"""
Dark-mode versions of the illustration set (apps/web/public/images/illustrations/*.webp -> dark/*.webp).

The artwork is a set of 3D renders on a light studio background. This keeps the objects exactly as drawn and replaces only the background: the smooth, light
area connected to the picture's edge (plus its pale teal blob, shadows and glow) is recoloured to the dark Nuzm surface by hue, keeping the original lighting.
A few objects are as white as the background itself, so they are listed in PROTECT (never recoloured) and the pockets of background they enclose in POCKET;
the polygons are in the picture's own pixels, doubled (read off a 50 px grid at 2x). Needs numpy and Pillow.   Usage: python3 scripts/illustrations-dark.py
"""
import math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent / 'apps' / 'web' / 'public' / 'images' / 'illustrations'
INSET = 6
RADIUS = 26

def ell(cx, cy, rx, ry, n=48):
    return [(cx + rx * math.cos(2 * math.pi * i / n), cy + ry * math.sin(2 * math.pi * i / n)) for i in range(n)]

PROTECT = {
    'builder': [[(104,165),(118,142),(600,100),(625,125),(690,170),(740,430),(738,480),(580,492),(540,520),(470,512),(160,522),(135,495),(115,230)]],
    'dashboard': [[(2*x, 2*y) for x, y in [(115,55),(560,70),(580,215),(570,340),(520,345),(360,368),(165,375),(150,345),(118,120)]]],
    'integrations': [[(378,172),(392,150),(470,142),(482,172),(512,172),(525,140),(600,140),(640,228),(668,355),(662,372),(560,388),(470,420),(425,412),(404,330),(335,318),(322,270),(345,232),(378,215)]],
    'security': [[(228,222),(520,222),(548,248),(548,470),(520,488),(250,490),(228,470)],
                 [(278,222),(284,110),(322,62),(400,50),(470,75),(494,130),(492,222),(448,222),(450,135),(432,105),(400,92),(345,100),(322,135),(320,222)]],
    'robot': [ell(405, 290, 215, 195)],
    'domain': [[(70,310),(110,265),(540,235),(680,240),(690,360),(610,395),(120,415),(80,395)],
               [(325,395),(640,395),(640,560),(600,640),(520,670),(330,680)]],
}
POCKET = {
    'security': [[(322,215),(324,138),(345,102),(400,94),(430,106),(448,138),(448,215)]],
    'support': [[(252,232),(262,172),(300,130),(350,100),(400,92),(452,108),(488,150),(500,228),(470,262),(372,272),(352,300),(340,268),(262,256)]],
}

def gauss_blur(a, s):
    k=int(max(1,round(s*3)))
    x=np.arange(-k,k+1); w=np.exp(-(x**2)/(2*s*s)); w/=w.sum()
    def conv1(arr,axis):
        pad=[(0,0)]*arr.ndim; pad[axis]=(k,k)
        p=np.pad(arr,pad,mode='edge')
        out=np.zeros_like(arr,dtype=float)
        for i,wi in enumerate(w):
            sl=[slice(None)]*arr.ndim; sl[axis]=slice(i,i+arr.shape[axis])
            out+=wi*p[tuple(sl)]
        return out
    return conv1(conv1(a.astype(float),0),1)

def dilate(m,n=1):
    m=m.copy()
    for _ in range(n):
        p=np.pad(m,1)
        m=p[1:-1,1:-1]|p[:-2,1:-1]|p[2:,1:-1]|p[1:-1,:-2]|p[1:-1,2:]
    return m
def erode(m,n=1): return ~dilate(~m,n)

def flood(cand, seeds):
    reach=seeds&cand
    while True:
        nxt=dilate(reach,1)&cand
        # add a few steps at once for speed
        nxt=dilate(nxt,3)&cand
        if (nxt==reach).all(): return reach
        reach=nxt


def rgb2hsv(a):
    a=a/255.0; r,g,b=a[...,0],a[...,1],a[...,2]
    mx=a.max(-1); mn=a.min(-1); d=mx-mn
    h=np.zeros_like(mx)
    m=d>1e-6
    rc=np.where(m,(mx-r)/np.where(m,d,1),0); gc=np.where(m,(mx-g)/np.where(m,d,1),0); bc=np.where(m,(mx-b)/np.where(m,d,1),0)
    h=np.where(mx==r,bc-gc,np.where(mx==g,2.0+rc-bc,4.0+gc-rc)); h=(h/6.0)%1.0
    h=np.where(m,h,0)
    s=np.where(mx>1e-6,d/np.where(mx>1e-6,mx,1),0)
    return h,s,mx
def hsv2rgb(h,s,v):
    i=np.floor(h*6).astype(int)%6; f=h*6-np.floor(h*6)
    p=v*(1-s); q=v*(1-f*s); t=v*(1-(1-f)*s)
    r=np.choose(i,[v,q,p,p,t,v]); g=np.choose(i,[t,v,v,q,p,p]); b=np.choose(i,[p,p,t,v,v,q])
    return np.stack([r,g,b],-1)*255


def darkify(rgb, erosion=6, grad_th=9, protect=None, pocket=None):
    a=rgb.astype(float); h,w,_=a.shape
    gx=np.abs(np.diff(a,axis=1,append=a[:,-1:,:])).max(axis=2)
    gy=np.abs(np.diff(a,axis=0,append=a[-1:,:,:])).max(axis=2)
    grad=np.maximum(gx,gy)
    grad=np.maximum(grad,np.pad(grad,1)[1:-1,2:]*0+grad)  # keep
    mn=a.min(axis=2); mx=a.max(axis=2); chroma=mx-mn
    bluish=(a[:,:,2]-a[:,:,0])>=3          # the studio background leans blue/teal; white and cream objects do not
    cand=(mn>186)&(grad<grad_th)&(chroma<62)
    seeds=np.zeros((h,w),bool); seeds[:4,:]=True; seeds[-4:,:]=True; seeds[:,:4]=True; seeds[:,-4:]=True
    core=flood(erode(cand,erosion),seeds)
    core=dilate(core,erosion+1)&(mn>170)&(grad<grad_th*2.2)
    # glow / halo: smooth, light, a little more colour, near the background
    near=dilate(core,26)
    tier2=near&(mn>140)&(grad<grad_th)&(chroma>=22)&(chroma<110)&((a[:,:,2]-a[:,:,0])>=12)&~core
    region=core|tier2
    if pocket is not None: region=region|pocket
    if protect is not None: region=region&~protect
    region=dilate(region,1)&~(protect if protect is not None else np.zeros_like(region))
    # recolour the region by hue, keeping the tile's lighting
    H,S,V=rgb2hsv(a)
    lum=(a[:,:,0]+a[:,:,1]+a[:,:,2])/3
    shade=np.clip((lum-120)/120,0,1)             # shadows (darker) -> deeper
    sat_n=np.clip(S/0.30,0,1)
    v_new=0.075+0.085*np.clip((lum-205)/45,0,1)+0.42*sat_n**1.2
    v_new=v_new*(0.55+0.45*shade)
    s_new=np.clip(0.16+S*1.9,0,0.85)
    h_new=np.where(S<0.045,0.58,H)               # neutral studio grey-blue stays grey-blue
    dark=hsv2rgb(h_new,s_new,v_new)
    alpha=np.clip(gauss_blur(region.astype(float),1.0),0,1)
    wgt=gauss_blur(region.astype(float),5)+1e-6
    bgfill=np.stack([gauss_blur(a[:,:,c]*region,5)/wgt for c in range(3)],axis=2)
    am=np.clip(alpha,0,0.96)[...,None]
    fg=np.clip((a-am*bgfill)/(1-am),0,255)
    fg=np.where((alpha<0.02)[...,None],a,fg)
    out=alpha[...,None]*dark+(1-alpha[...,None])*fg
    return np.clip(out,0,255).astype(np.uint8), region



def poly_mask(shape, polys):
    h, w = shape
    im = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(im)
    for p in polys:
        d.polygon([((x / 2) - INSET, (y / 2) - INSET) for x, y in p], fill=255)
    return np.array(im) > 127

def main():
    out_dir = ROOT / 'dark'
    out_dir.mkdir(exist_ok=True)
    for f in sorted(ROOT.glob('*.webp')):
        name = f.stem
        im = Image.open(f).convert('RGBA')
        full = np.array(im.convert('RGB'))
        tile = full[INSET:-INSET, INSET:-INSET]
        protect = poly_mask(tile.shape[:2], PROTECT.get(name, []))
        pocket = poly_mask(tile.shape[:2], POCKET.get(name, []))
        dark, _ = darkify(tile, protect=protect, pocket=pocket)
        dark = np.pad(dark, ((INSET, INSET), (INSET, INSET), (0, 0)), mode='edge')
        res = Image.fromarray(dark).convert('RGBA')
        w, h = res.size
        mask = Image.new('L', (w * 4, h * 4), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, w * 4 - 1, h * 4 - 1), radius=RADIUS * 4, fill=255)
        res.putalpha(mask.resize((w, h), Image.LANCZOS))
        res.save(out_dir / f.name, quality=92, method=6)
        print(name, res.size)

if __name__ == '__main__':
    main()
