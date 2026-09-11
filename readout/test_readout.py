import unittest
import numpy as np
from geometry_readout import Readout, Config


def topology(v,f):
    owners={}
    for i,(a,b,c) in enumerate(f):
        for x,y in ((a,b),(b,c),(c,a)):
            key=tuple(sorted((int(x),int(y))));owners.setdefault(key,[]).append(i)
    keys=list(owners)
    incident=np.array([owners[k] if len(owners[k])==2 else owners[k]+[-1] for k in keys])
    return incident,np.array([v[list(k)] for k in keys])


def grid(n=24,hinge=False):
    v=[]
    for y in range(n+1):
        for x in range(n+1):
            a=x/n-.5;b=y/n
            v.append([a,b,abs(a)*.75 if hinge else 0])
    f=[]
    for y in range(n):
        for x in range(n):
            a=y*(n+1)+x;b=a+1;c=a+n+1;d=c+1
            f.extend([[a,b,d],[a,d,c]])
    return np.array(v,dtype=float),np.array(f)


def cylinder(n=48,h=12):
    v=np.array([[np.cos(2*np.pi*i/n),np.sin(2*np.pi*i/n),j/h*2] for j in range(h+1) for i in range(n)])
    f=[]
    for j in range(h):
        for i in range(n):
            a=j*n+i;b=j*n+(i+1)%n;c=a+n;d=b+n
            f.extend([[a,b,d],[a,d,c]])
    return v,np.array(f)


def solve(v,f,p,**options):
    incident,positions=topology(v,f)
    probabilities=np.full(len(incident),p) if np.isscalar(p) else p
    cfg=Config(min_faces=25,min_area_fraction=.01,seed_faces=24,**options)
    return Readout(v,f,incident,probabilities,positions,cfg).run(log=lambda _:None)


class ReadoutTests(unittest.TestCase):
    def test_plane_not_fragmented_by_random_false_edges(self):
        v,f=grid();inc,pos=topology(v,f)
        p=np.full(len(inc),.01);p[np.random.default_rng(7).choice(len(p),len(p)//15,replace=False)]=.99
        labels,report=solve(v,f,p)
        self.assertEqual(report['patch_count'],1)

    def test_low_probability_crease_is_recovered(self):
        v,f=grid(hinge=True);labels,report=solve(v,f,.02)
        self.assertEqual(report['patch_count'],2)
        side=v[f].mean(axis=1)[:,0]>0
        self.assertEqual(len(np.unique(labels[side])),1)
        self.assertEqual(len(np.unique(labels[~side])),1)
        self.assertNotEqual(labels[side][0],labels[~side][0])
        self.assertGreater(report['low_probability_cut_edges'],0)

    def test_cylinder_not_split_into_planes(self):
        v,f=cylinder();labels,report=solve(v,f,.01)
        self.assertEqual(report['patch_count'],1)

    def test_tiny_high_probability_island_removed(self):
        v,f=grid();inc,pos=topology(v,f);p=np.full(len(inc),.01)
        center=np.linalg.norm(v[f].mean(axis=1)[:,:2]-[0,.5],axis=1)<.05
        internal=inc[:,1]>=0;ii=inc[internal]
        p[np.flatnonzero(internal)[center[ii[:,0]]!=center[ii[:,1]]]]=.999
        labels,report=solve(v,f,p)
        self.assertEqual(report['patch_count'],1)
        self.assertTrue(report['minimum_support_satisfied'])

    def test_translation_scale_invariance(self):
        v,f=grid(hinge=True);a,_=solve(v,f,.02);b,_=solve(v*1000+[10000,-350,999],f,.02)
        # Compare partitions independently of arbitrary label ids.
        for label in np.unique(a):self.assertEqual(len(np.unique(b[a==label])),1)
        self.assertEqual(len(np.unique(a)),len(np.unique(b)))

    def test_no_prediction_is_neutral(self):
        v,f=grid();labels,report=solve(v,f,np.nan)
        self.assertEqual(report['patch_count'],1)
        self.assertGreater(report['missing_predictions'],0)

    def test_impossible_minimum_rejected(self):
        v=np.array([[0.,0,0],[1,0,0],[0,1,0],[10,0,0],[11,0,0],[10,1,0]])
        f=np.array([[0,1,2],[3,4,5]])
        with self.assertRaisesRegex(ValueError,'disconnected component'):
            solve(v,f,.5)

    def test_split_can_reopen_an_incorrect_merge(self):
        v,f=grid(hinge=True);inc,pos=topology(v,f)
        solver=Readout(v,f,inc,np.full(len(inc),.02),pos,Config(min_faces=25,min_area_fraction=.01))
        labels,accepted=solver.split(np.zeros(len(f),dtype=int))
        self.assertEqual(accepted,1)
        solver.validate(labels)

    def test_supported_network_boundary_on_a_plane(self):
        v,f=grid();inc,pos=topology(v,f);p=np.full(len(inc),.01)
        side=v[f].mean(axis=1)[:,0]>0
        internal=inc[:,1]>=0;ii=inc[internal]
        p[np.flatnonzero(internal)[side[ii[:,0]]!=side[ii[:,1]]]]=.99
        labels,report=solve(v,f,p)
        self.assertEqual(report['patch_count'],2)
        self.assertLessEqual(report['final_energy']['total'],report['energy_after_minimum']['total']+1e-8)


if __name__=='__main__':unittest.main(verbosity=2)
