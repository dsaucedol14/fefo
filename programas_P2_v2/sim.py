# Caso simulado P2 — datos SINTÉTICOS (semilla fija, reproducible)
import random, math, csv, statistics as st, json, datetime as dt, argparse, os

parser = argparse.ArgumentParser()
parser.add_argument("--salida", required=True, help="Carpeta donde se escriben los CSV (p. ej. datos/sim_v2)")
args = parser.parse_args()

random.seed(20261117)
OUT = args.salida.rstrip("/") + "/"
os.makedirs(OUT, exist_ok=True)
D0=dt.date(2026,9,7); DAYS=48  # 8 semanas x 6 días laborables
days=[]; d=D0
while len(days)<DAYS:
    if d.weekday()<6: days.append(d)
    d+=dt.timedelta(days=1)
cats=[("Lácteos",8,25,True,0.55),("Embutidos",8,35,True,0.45),("Abarrotes",16,240,False,0.25),("Bebidas",10,180,False,0.30),("Botanas",6,90,False,0.40)]
prods=[]; k=1
for c,n,vida,frio,var in cats:
    for i in range(n):
        prods.append(dict(sku=f"P{k:03d}",categoria=c,vida_util_dias=vida+random.randint(-int(vida*.2),int(vida*.2)),
          frio=frio,var_vida=var,cajas_tarima=random.choice([40,48,60,72,80]),
          costo_caja=round(random.uniform(120,520),2),dem=random.uniform(4,22)))
        k+=1
# posiciones
pos=[]
for p in range(1,5):
    for r in range(1,9):
        for n in range(1,4): pos.append(dict(id=f"A-P{p:02d}-R{r:02d}-N{n}",zona="A",tipo="rack",prof=1))
for f in range(1,29):
    for pr in range(1,5): pos.append(dict(id=f"B-F{f:02d}-D{pr}",zona="B",tipo="piso",prof=pr))
for r in range(1,13):
    for n in range(1,3): pos.append(dict(id=f"C-R{r:02d}-N{n}",zona="C",tipo="camara",prof=1))
free={p["id"]:p for p in pos}; occ={}
sin_espacio=[]; lots=[]; tar=[]; movs=[]; picks=[]; mermas=[]
lid=1; tid=1
def place(frio):
    cand=[p for p in free.values() if (p["zona"]=="C")==frio]
    if not cand: cand=list(free.values())
    if not cand: return None
    # tendencia manual: llenar primero lo más cercano a la entrada (fondo de filas en piso se usa tarde)
    random.shuffle(cand); cand.sort(key=lambda p:(p["zona"]=="B" and p["prof"]<2, random.random()))
    p=cand[0]; free.pop(p["id"]); return p
stock={p["sku"]:[] for p in prods}
for di,day in enumerate(days):
    # entradas
    for pr in prods:
        tot=sum(l["qty"] for l in stock[pr["sku"]])
        if tot< pr["dem"]*6 and random.random()<0.6:
            n_t=1 if pr["dem"]<12 else 2
            for _ in range(n_t):
                p=place(pr["frio"])
                if p is None: sin_espacio.append(day); break
                tcode=f"T{tid:04d}"; tid+=1
                mixto = random.random()<0.22
                nl=random.choice([2,3]) if mixto else 1
                cajas=pr["cajas_tarima"]
                for j in range(nl):
                    rem=pr["vida_util_dias"]*random.uniform(1-pr["var_vida"],1.0)
                    exp=day+dt.timedelta(days=int(rem))
                    q=cajas//nl
                    L=dict(lote=f"L{lid:05d}",sku=pr["sku"],tarima=tcode,qty=q,qty0=q,recep=day,cad=exp,pos=p["id"],zona=p["zona"],prof=p["prof"],
                           pos_reg=p["id"])
                    lid+=1; stock[pr["sku"]].append(L); lots.append(L)
                occ[p["id"]]=tcode
                tar.append(dict(tarima=tcode,fecha_recepcion=day,posicion=p["id"],lotes=nl,mixta=int(mixto)))
                movs.append(dict(fecha=day,tipo="ENTRADA",tarima=tcode,sku=pr["sku"],cajas=cajas,origen="ANDEN",destino=p["id"],registrado=1))
    # reacomodos internos
    for _ in range(random.randint(3,8)):
        alive=[l for s in stock.values() for l in s if l["qty"]>0]
        if not alive: break
        l=random.choice(alive); tgt=[p for p in free.values()]
        if not tgt: break
        p=random.choice(tgt); free.pop(p["id"])
        old=l["pos"]
        reg = random.random()>0.31
        for x in [y for s in stock.values() for y in s if y["tarima"]==l["tarima"]]:
            x["pos"]=p["id"]; x["zona"]=p["zona"]; x["prof"]=p["prof"]
            if reg: x["pos_reg"]=p["id"]
        free[old]=next(q for q in pos if q["id"]==old)
        movs.append(dict(fecha=day,tipo="REUBICACION",tarima=l["tarima"],sku=l["sku"],cajas=0,origen=old,destino=p["id"],registrado=int(reg)))
    # salidas (selección manual: la más accesible; empate → la más antigua)
    for pr in prods:
        dem=max(0,int(random.gauss(pr["dem"],pr["dem"]*.35)))
        while dem>0:
            av=[l for l in stock[pr["sku"]] if l["qty"]>0 and l["cad"]>=day]
            if not av: break
            fefo=min(av,key=lambda l:(l["cad"],l["recep"]))
            ch=min(av,key=lambda l:(l["prof"],l["recep"],random.random()))
            if random.random()<0.18: ch=fefo   # a veces el almacenista revisa la fecha
            q=min(dem,ch["qty"]); ch["qty"]-=q; dem-=q
            picks.append(dict(fecha=day,sku=pr["sku"],lote_elegido=ch["lote"],cad_elegido=ch["cad"],lote_fefo=fefo["lote"],cad_fefo=fefo["cad"],
                cajas=q,conforme_fefo=int(ch["cad"]<=fefo["cad"]),dias_dif=(ch["cad"]-fefo["cad"]).days,
                fifo_difiere=int(min(av,key=lambda l:l["recep"])["lote"]!=fefo["lote"])))
            movs.append(dict(fecha=day,tipo="SALIDA",tarima=ch["tarima"],sku=pr["sku"],cajas=q,origen=ch["pos"],destino="CLIENTE",registrado=1))
    # caducados al cierre
    for pr in prods:
        for l in stock[pr["sku"]]:
            if l["qty"]>0 and l["cad"]<day:
                mermas.append(dict(fecha=day,lote=l["lote"],sku=pr["sku"],categoria=pr["categoria"],cajas=l["qty"],valor=round(l["qty"]*pr["costo_caja"],2),zona=l["zona"],prof=l["prof"]))
                movs.append(dict(fecha=day,tipo="BAJA_CADUCIDAD",tarima=l["tarima"],sku=pr["sku"],cajas=l["qty"],origen=l["pos"],destino="MERMA",registrado=1))
                l["qty"]=0
    # liberar posiciones vacías
    for t in sorted(set(occ.values())):
        ls=[l for s in stock.values() for l in s if l["tarima"]==t]
        if ls and all(l["qty"]==0 for l in ls):
            pid=ls[0]["pos"]
            if pid not in free: free[pid]=next(q for q in pos if q["id"]==pid)
            for kk in [kk for kk,v in occ.items() if v==t]: occ.pop(kk)
# observación: 60 tareas de localización cronometradas (procedimiento manual)
alive=[l for l in lots if l["qty"]>0]
obs=[]
base={"A":70,"B":95,"C":60}
for i in range(60):
    l=random.choice(alive)
    ok = l["pos"]==l["pos_reg"]
    t=base[l["zona"]]+ (l["prof"]-1)*55 + (0 if ok else random.uniform(150,520))
    t*=math.exp(random.gauss(0,.25))
    loc=int(t<900); t=min(t,900)
    obs.append(dict(obs=f"O{i+1:02d}",lote=l["lote"],tarima=l["tarima"],zona=l["zona"],profundidad=l["prof"],
        ubicacion_registrada_correcta=int(ok),tarimas_movidas=max(0,l["prof"]-1) if l["zona"]=="B" else 0,tiempo_s=round(t),localizada=loc,
        observador=random.choice(["OBS-1","OBS-2"])))
def W(name,rows):
    with open(OUT+name,"w",newline="",encoding="utf-8") as f:
        w=csv.DictWriter(f,fieldnames=list(rows[0].keys())); w.writeheader(); [w.writerow(r) for r in rows]
W("productos.csv",[{k:v for k,v in p.items() if k not in("dem","var_vida")} for p in prods])
W("posiciones.csv",[dict(id=p["id"],zona=p["zona"],tipo=p["tipo"],profundidad=p["prof"]) for p in pos])
W("lotes.csv",[dict(lote=l["lote"],sku=l["sku"],tarima=l["tarima"],cajas_recibidas=l["qty0"],fecha_recepcion=l["recep"],fecha_caducidad=l["cad"],
   posicion_real_final=l["pos"],posicion_registrada_final=l["pos_reg"],cajas_finales=l["qty"]) for l in lots])
W("tarimas.csv",tar); W("movimientos.csv",movs); W("selecciones.csv",picks); W("mermas.csv",mermas); W("observaciones.csv",obs)
# resumen
S={}
S["productos"]=len(prods); S["posiciones"]=len(pos); S["tarimas"]=len(tar); S["lotes"]=len(lots)
S["tarimas_mixtas_pct"]=round(100*sum(t["mixta"] for t in tar)/len(tar),1)
from collections import Counter
c=Counter(m["tipo"] for m in movs); S["movs"]=dict(c)
S["por_dia"]={k:round(v/DAYS,1) for k,v in c.items()}
S["selecciones"]=len(picks); S["fefo_conf_pct"]=round(100*sum(p["conforme_fefo"] for p in picks)/len(picks),1)
nc=[p for p in picks if not p["conforme_fefo"]]; S["dias_dif_mediana_nc"]=st.median(p["dias_dif"] for p in nc)
S["fifo_difiere_pct"]=round(100*sum(p["fifo_difiere"] for p in picks)/len(picks),1)
reub=[m for m in movs if m["tipo"]=="REUBICACION"]; S["reub_no_reg_pct"]=round(100*sum(1-m["registrado"] for m in reub)/len(reub),1)
recv=sum(l["qty0"] for l in lots); mc=sum(m["cajas"] for m in mermas); S["merma_cajas"]=mc; S["merma_pct_cajas"]=round(100*mc/recv,2)
S["merma_valor"]=round(sum(m["valor"] for m in mermas),2); S["lotes_caducados"]=len(mermas)
S["merma_por_cat"]={k:round(sum(m["valor"] for m in mermas if m["categoria"]==k),0) for k in [c[0] for c in cats]}
S["merma_por_prof"]=dict(Counter(m["prof"] for m in mermas if m["zona"]=="B"))
S["merma_zona"]=dict(Counter(m["zona"] for m in mermas))
ts=[o["tiempo_s"] for o in obs]; S["t_med"]=st.median(ts); S["t_p90"]=sorted(ts)[int(.9*len(ts))-1]; S["t_mean"]=round(st.mean(ts),1)
S["t_ok_med"]=st.median(o["tiempo_s"] for o in obs if o["ubicacion_registrada_correcta"])
S["t_bad_med"]=st.median(o["tiempo_s"] for o in obs if not o["ubicacion_registrada_correcta"])
S["exactitud_ubic_pct"]=round(100*sum(o["ubicacion_registrada_correcta"] for o in obs)/len(obs),1)
S["obs_bad_n"]=sum(1-o["ubicacion_registrada_correcta"] for o in obs)
S["t_por_prof"]={p:st.median([o["tiempo_s"] for o in obs if o["profundidad"]==p and o["ubicacion_registrada_correcta"]] or [0]) for p in range(1,5)}
S["n_por_prof"]={p:sum(1 for o in obs if o["profundidad"]==p) for p in range(1,5)}
S["dias_sin_espacio"]=len(set(sin_espacio)); S["max_dia_mov"]=max(Counter(m["fecha"] for m in movs).values())
S["periodo"]=f"{days[0]} a {days[-1]}"
print(json.dumps(S,ensure_ascii=False,indent=1,default=str))
json.dump(S,open(OUT+"resumen.json","w"),ensure_ascii=False,default=str)
al=[l for l in lots if l["qty"]>0]
print("lotes_vivos",len(al),"exactitud_inventario_final_pct",round(100*sum(l["pos"]==l["pos_reg"] for l in al)/len(al),1))
tt=set(l["tarima"] for l in al); print("tarimas_vivas",len(tt))
print("merma_valor",S["merma_valor"],S["merma_por_cat"])
