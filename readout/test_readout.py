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


def axial_rings(v,f):
    inc,_=topology(v,f)
    levels=np.floor(v[f].mean(axis=1)[:,2]*2+1e-8).astype(int)
    p=np.full(len(inc),.01)
    ii=np.flatnonzero(inc[:,1]>=0)
    p[ii[levels[inc[ii,0]]!=levels[inc[ii,1]]]]=.9999
    return p


def freeform_grid(n=48):
    v,f=grid(n)
    x,y=v[:,:2].T
    v[:,2]=.07*np.sin(3*np.pi*x)*np.cos(2*np.pi*y)+.08*np.sin(2*np.pi*y)+.12*x*y
    return v,f


class ReadoutTests(unittest.TestCase):
    def test_freeform_low_probability_does_not_require_global_quadric(self):
        v,f=freeform_grid()
        labels,report=solve(v,f,.01)
        self.assertEqual(report['patch_count'],1)
        self.assertGreater(report['surface_merges'].get('freeform',0),0)

    def test_freeform_merge_preserves_supported_probability_boundary(self):
        v,f=freeform_grid()
        inc,pos=topology(v,f);p=np.full(len(inc),.01)
        side=v[f].mean(axis=1)[:,0]>0
        ii=np.flatnonzero(inc[:,1]>=0)
        p[ii[side[inc[ii,0]]!=side[inc[ii,1]]]]=.99
        solver=Readout(v,f,inc,p,pos,Config(min_faces=25,min_area_fraction=.01))
        # The new merge criterion must preserve this already-observed seam;
        # this does not assert the full initializer recovers exact CAD labels.
        labels=solver.coarsen(side.astype(int))
        self.assertEqual(len(np.unique(labels)),2)
        self.assertTrue(set(labels[side]).isdisjoint(set(labels[~side])))

    def test_freeform_rule_rejects_low_probability_curvature_jump(self):
        v,f=grid(48);v[:,2]=np.maximum(v[:,0],0)**2*1.5
        inc,pos=topology(v,f)
        s=Readout(v,f,inc,np.full(len(inc),.01),pos,Config(min_faces=25,min_area_fraction=.01))
        side=v[f].mean(axis=1)[:,0]>0;ii=np.flatnonzero(inc[:,1]>=0)
        interface=ii[side[inc[ii,0]]!=side[inc[ii,1]]]
        self.assertIsNone(s.freeform.certify(interface))

    def test_freeform_rule_does_not_use_a_low_probability_gap(self):
        v,f=freeform_grid();inc,pos=topology(v,f);p=np.full(len(inc),.01)
        side=v[f].mean(axis=1)[:,0]>0;ii=np.flatnonzero(inc[:,1]>=0)
        interface=ii[side[inc[ii,0]]!=side[inc[ii,1]]];p[interface]=.99;p[interface[:2]]=.001
        s=Readout(v,f,inc,p,pos,Config(min_faces=25,min_area_fraction=.01))
        self.assertIsNone(s.freeform.certify(interface))

    def test_freeform_split_does_not_cut_for_global_fit_error(self):
        v,f=freeform_grid();inc,pos=topology(v,f)
        solver=Readout(v,f,inc,np.full(len(inc),.01),pos,Config(min_faces=25,min_area_fraction=.01))
        labels,accepted=solver.split(np.zeros(len(f),dtype=int))
        self.assertEqual(accepted,0)
        self.assertGreater(solver.report['surface_split_vetoes'],0)

    def test_freeform_missing_predictions_do_not_claim_low_probability(self):
        v,f=freeform_grid();inc,pos=topology(v,f)
        solver=Readout(v,f,inc,np.full(len(inc),np.nan),pos,Config(min_faces=25,min_area_fraction=.01))
        side=v[f].mean(axis=1)[:,0]>0;ii=np.flatnonzero(inc[:,1]>=0)
        interface=ii[side[inc[ii,0]]!=side[inc[ii,1]]]
        self.assertIsNone(solver.freeform.certify(interface))

    def test_diffuse_high_probability_is_not_a_freeform_boundary_line(self):
        v,f=freeform_grid(96);inc,pos=topology(v,f)
        solver=Readout(v,f,inc,np.full(len(inc),.7),pos,Config(min_faces=25,min_area_fraction=.01))
        side=v[f].mean(axis=1)[:,0]>0
        labels=solver.coarsen(side.astype(int))
        self.assertEqual(len(np.unique(labels)),1)

    def test_moderate_probability_ridge_still_blocks_freeform_merge(self):
        v,f=freeform_grid();inc,pos=topology(v,f);p=np.full(len(inc),.01)
        side=v[f].mean(axis=1)[:,0]>0;ii=np.flatnonzero(inc[:,1]>=0)
        interface=ii[side[inc[ii,0]]!=side[inc[ii,1]]];p[interface]=.7
        solver=Readout(v,f,inc,p,pos,Config(min_faces=25,min_area_fraction=.01))
        self.assertIsNone(solver.freeform.certify(interface))

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

    def test_equivalent_plane_overrides_high_probability_boundary(self):
        v,f=grid();inc,pos=topology(v,f);p=np.full(len(inc),.01)
        side=v[f].mean(axis=1)[:,0]>0
        internal=inc[:,1]>=0;ii=inc[internal]
        p[np.flatnonzero(internal)[side[ii[:,0]]!=side[ii[:,1]]]]=.99
        labels,report=solve(v,f,p)
        self.assertEqual(report['patch_count'],1)
        self.assertGreater(report['surface_merges'].get('plane',0),0)

    def test_high_probability_rings_on_cylinder(self):
        v,f=cylinder();labels,report=solve(v,f,axial_rings(v,f))
        self.assertEqual(report['patch_count'],1)
        self.assertGreater(report['surface_merges'].get('revolution',0),0)

    def test_high_probability_rings_on_cone(self):
        v,f=cylinder(h=24)
        v[:,:2]*=(1-.35*v[:,2,None])
        labels,report=solve(v,f,axial_rings(v,f))
        self.assertEqual(report['patch_count'],1)

    def test_regular_curvature_change(self):
        v,f=grid(36)
        v[:,2]=.6*v[:,0]**2+.15*v[:,0]**3
        inc,_=topology(v,f);p=np.full(len(inc),.01)
        side=np.floor((v[f].mean(axis=1)[:,0]+.5)*3).astype(int)
        ii=np.flatnonzero(inc[:,1]>=0)
        p[ii[side[inc[ii,0]]!=side[inc[ii,1]]]]=.999
        labels,report=solve(v,f,p)
        self.assertEqual(report['patch_count'],1)

    def test_tangent_plane_curved_surface_retains_interface(self):
        v,f=grid(36)
        v[:,2]=np.maximum(v[:,0],0)**2*1.5
        inc,pos=topology(v,f)
        solver=Readout(v,f,inc,np.full(len(inc),.99),pos,Config(min_faces=25,min_area_fraction=.01))
        side=v[f].mean(axis=1)[:,0]>0
        self.assertIsNone(solver.evidence.certify(np.flatnonzero(side),np.flatnonzero(~side)))
        labels=solver.coarsen(side.astype(int))
        self.assertEqual(len(np.unique(labels)),2)

    def test_distinct_coaxial_cones_retained(self):
        v,f=cylinder(h=24)
        v[:,:2]*=(1-.1*v[:,2,None]-.3*np.maximum(v[:,2,None]-1,0))
        inc,pos=topology(v,f)
        solver=Readout(v,f,inc,axial_rings(v,f),pos,Config(min_faces=25,min_area_fraction=.01))
        side=v[f].mean(axis=1)[:,2]>1
        self.assertIsNone(solver.evidence.certify(np.flatnonzero(side),np.flatnonzero(~side)))
        labels,report=solver.run(log=lambda _:None)
        self.assertGreaterEqual(report['patch_count'],2)
        self.assertTrue(set(labels[side]).isdisjoint(set(labels[~side])))

    def test_surface_rule_is_shared_by_split(self):
        v,f=cylinder(h=24);v[:,:2]*=(1-.35*v[:,2,None])
        inc,pos=topology(v,f)
        solver=Readout(v,f,inc,axial_rings(v,f),pos,Config(min_faces=25,min_area_fraction=.01))
        labels,accepted=solver.split(np.zeros(len(f),dtype=int))
        self.assertEqual(accepted,0)
        self.assertGreater(solver.report['surface_split_vetoes'],0)

    def test_round_transition_revolution_merges(self):
        v,f=cylinder(n=72,h=24)
        t=v[:,2]*np.pi/4
        v[:,:2]*=(2-.5*np.cos(t))[:,None]
        v[:,2]=.5*np.sin(t)
        inc,pos=topology(v,f)
        # Two circumference sectors and two meridional bands of one torus.
        xyz=v[f].mean(axis=1)
        labels=(xyz[:,0]>0).astype(int)+2*(xyz[:,2]>.35)
        p=np.full(len(inc),.01);ii=np.flatnonzero(inc[:,1]>=0)
        p[ii[labels[inc[ii,0]]!=labels[inc[ii,1]]]]=.999
        s=Readout(v,f,inc,p,pos,Config(min_faces=25,min_area_fraction=.01))
        result=s.coarsen(labels)
        self.assertEqual(len(np.unique(result)),1)
        self.assertGreater(s.report['surface_merges'].get('torus',0),0)

    def test_union_revalidation_blocks_transitive_leak(self):
        v,f=grid(48)
        v[:,2]=np.maximum(v[:,0]-.15,0)**2*4
        inc,pos=topology(v,f)
        side=np.where(v[f].mean(axis=1)[:,0]<-.15,0,np.where(v[f].mean(axis=1)[:,0]<.15,1,2))
        s=Readout(v,f,inc,np.full(len(inc),.99),pos,Config(min_faces=25,min_area_fraction=.01))
        labels=s.coarsen(side.copy())
        self.assertEqual(len(np.unique(labels[side<2])),1)
        self.assertTrue(set(labels[side<2]).isdisjoint(set(labels[side==2])))
        # A second coarsening call must retain the certified union's envelope.
        labels=s.coarsen(labels)
        self.assertTrue(set(labels[side<2]).isdisjoint(set(labels[side==2])))

    def test_rotated_scaled_cone_with_noise(self):
        v,f=cylinder(n=72,h=24);v[:,:2]*=(1-.25*v[:,2,None])
        probabilities=axial_rings(v,f)
        v+=np.random.default_rng(42).normal(0,.00015,v.shape)
        rotation,_=np.linalg.qr(np.array([[1.,2.,3.],[4.,-3.,1.],[2.,1.,-2.]]))
        v=(v@rotation)*150+[100,-350,230]
        labels,report=solve(v,f,probabilities)
        self.assertEqual(report['patch_count'],1)

    def test_bent_cylinder_axes_remain_distinct(self):
        v,f=cylinder(n=72,h=24)
        v[:,0]+=.6*np.maximum(v[:,2]-1,0)
        inc,pos=topology(v,f)
        s=Readout(v,f,inc,axial_rings(v,f),pos,Config(min_faces=25,min_area_fraction=.01))
        side=v[f].mean(axis=1)[:,2]>1
        self.assertIsNone(s.evidence.certify(np.flatnonzero(side),np.flatnonzero(~side)))


if __name__=='__main__':unittest.main(verbosity=2)
