__M["src/config.js"]=(()=>{

const common = {
  hs: 0.5,
  period: 5.2,
  direction: -0.55,
  chop: 0.65,
  depth: 18,
  sky: "blue",
  exposure: 1.05,
  sun: [-0.3059247094681465, 0.7419804117208311, -0.5965527141497358],
  sunColor: [2.3, 2.25, 2.12],
  wind: 5,
  roughness: 0.053,
  absorption: [0.19, 0.047, 0.021],
  scattering: [0.009, 0.017, 0.021],
  waterLight: [0.065, 0.34, 0.41],
  foamThreshold: 0.46,
  foamGain: 1,
  foamLifetime: 9,
  bed: [5, 0.07, 0.035, 0],
  terrain: false,
  rain: 0,
  boat: false,
  buoys: false,
  underwater: false,
  caustics: false,
};
const PRESETS = {
  dawn: {
    ...common,
    name: "First light / ocean",
    description: "GPU FFT • exact spectral slopes • low-angle solar reflection",
    hs: 2.7,
    period: 8.2,
    chop: 0.63,
    depth: 180,
    sky: "dawn",
    sun: [-0.7215476372512444, 0.03527423889821395, -0.6914656428538574],
    sunColor: [2.1, 1.1, 0.46],
    wind: 8,
    roughness: 0.055,
    bed: [180, 0, 0, 0],
  },
  blue: {
    ...common,
    name: "Open ocean",
    description: "Three disjoint wave bands • directional wind sea",
    hs: 3.4,
    period: 7.4,
    chop: 0.65,
    depth: 90,
    wind: 11,
    roughness: 0.072,
    bed: [90, 0, 0, 0],
  },
  storm: {
    ...common,
    name: "Heavy weather",
    description: "Persistent crest foam • velocity-driven spray • wind drag",
    hs: 6.8,
    period: 9.4,
    chop: 0.53,
    depth: 300,
    sky: "storm",
    sun: [-0.6, 0.2, -0.77],
    sunColor: [0.7, 0.78, 0.85],
    wind: 19,
    roughness: 0.1,
    foamThreshold: 0.65,
    foamGain: 1.15,
    foamLifetime: 7,
    bed: [300, 0, 0, 0],
    exposure: 1.17,
  },
  swell: {
    ...common,
    name: "Long-period swell",
    description: "Gravity-wave dispersion • large-scale surface displacement",
    hs: 5.4,
    period: 12.3,
    depth: 180,
    chop: 0.64,
    wind: 10,
    sky: "dawn",
    sun: [-0.7215476372512444, 0.03527423889821395, -0.6914656428538574],
    sunColor: [2.1, 1.1, 0.46],
    bed: [180, 0, 0, 0],
  },
  lagoon: {
    ...common,
    name: "The rocky cove",
    description: "Geometry-aware transmission • refracted seafloor caustics",
    hs: 0.42,
    period: 4.7,
    depth: 12,
    terrain: true,
    caustics: true,
    bed: [4.6, 0.072, 0.022, 1],
    absorption: [0.16, 0.033, 0.015],
    scattering: [0.006, 0.013, 0.017],
    waterLight: [0.12, 0.51, 0.59],
    wind: 3,
    roughness: 0.042,
  },
  reef: {
    ...common,
    name: "Rock / water interface",
    description:
      "Wet shoreline • geometric intersections • depth-dependent extinction",
    hs: 1.15,
    period: 6.0,
    depth: 14,
    terrain: true,
    caustics: true,
    bed: [4.6, 0.072, 0.022, 1],
    wind: 7,
    foamThreshold: 0.7,
    foamGain: 0.9,
  },
  harbor: {
    ...common,
    name: "Under power",
    description:
      "Floating rigid hull • local wave response • persistent stern wake",
    hs: 0.45,
    period: 4.8,
    depth: 18,
    terrain: true,
    boat: true,
    caustics: true,
    bed: [6.5, 0.025, 0.005, 1],
    wind: 4,
  },
  buoy: {
    ...common,
    name: "Six degrees of freedom",
    description:
      "Distributed hydrostatics • relative-flow drag • angular response",
    hs: 1.4,
    period: 6.4,
    depth: 26,
    buoys: true,
    bed: [26, 0, 0, 0],
    wind: 8,
  },
  rain: {
    ...common,
    name: "Rain on the cove",
    description: "Seeded rainfall • impact impulses • interacting ripple field",
    hs: 0.13,
    period: 3.1,
    depth: 12,
    terrain: true,
    rain: 1,
    sky: "storm",
    sun: [-0.6, 0.2, -0.77],
    sunColor: [0.85, 0.95, 1.1],
    exposure: 1.2,
    bed: [4.6, 0.072, 0.022, 1],
    roughness: 0.04,
    wind: 3,
  },
  clear: {
    ...common,
    name: "Optics / clear water",
    description: "The same scene • low extinction • visible seafloor",
    hs: 0.27,
    period: 4.4,
    depth: 12,
    terrain: true,
    caustics: true,
    bed: [4.6, 0.072, 0.022, 1],
    absorption: [0.105, 0.022, 0.011],
    scattering: [0.003, 0.006, 0.009],
    waterLight: [0.1, 0.45, 0.51],
    wind: 2,
    roughness: 0.037,
  },
  turbid: {
    ...common,
    name: "Optics / suspended sediment",
    description: "The same scene • greater scattering • shorter visibility",
    hs: 0.27,
    period: 4.4,
    depth: 12,
    terrain: true,
    caustics: true,
    bed: [4.6, 0.072, 0.022, 1],
    absorption: [0.24, 0.13, 0.08],
    scattering: [0.085, 0.09, 0.081],
    waterLight: [0.2, 0.32, 0.27],
    wind: 2,
    roughness: 0.037,
  },
  glass: {
    ...common,
    name: "Capillary detail",
    description:
      "Calm sea • millimetric capillary normals • interface reflection",
    hs: 0.075,
    period: 2.2,
    depth: 10,
    terrain: true,
    caustics: true,
    bed: [3.5, 0.06, 0.01, 1],
    wind: 0.8,
    roughness: 0.028,
  },
};
const FIXED_DT = 1 / 60;
const SEED = 91317;

PRESETS.bubbles={...PRESETS.clear,name:"Bubble column / open water",description:"Secondary bubble transport • no emitter hidden inside a rock",bubbleEmitter:[0,-3.7,-2]};

PRESETS.silver = { ...PRESETS.blue, name:"Silver sea", description:"Oblique daylight / directional swells", hs:2.1, period:7.8, roughness:.065, wind:8 };
PRESETS.afterglow = { ...PRESETS.dawn, name:"Afterglow", description:"Long-period swell / warm low-angle sky", hs:1.15, period:8.8, roughness:.06, wind:4, exposure:1.16 };

// Rotate the entire measured environment: sun, reflection lookup and diffuse SH.
// The daylight cove is front-lit without introducing an unrelated fake fill light.
for (const key of ["lagoon","clear","turbid","reef","harbor","glass","bubbles"]) PRESETS[key].skyYaw=Math.PI;

// Foam is an unresolved visual closure, not resolved overturning surf.
Object.assign(PRESETS.storm,{foamThreshold:.91,foamGain:1.35,foamLifetime:8.5});
Object.assign(PRESETS.blue,{foamThreshold:.80,foamGain:.85});
Object.assign(PRESETS.silver,{foamThreshold:.80,foamGain:.85});



// Separate optics scenes use small, short-period waves; no caustic texture animation.
PRESETS.shallows = {...PRESETS.clear,name:'Sunlit shallows',
 description:'Continuous refracted caustics / sand, stone and moving light',
 hs:.25,period:1.85,chop:.50,depth:3.1,wind:2.4,roughness:.035,
 bed:[3.05,.024,.006,0],sunColor:[4.2,3.95,3.6],
 absorption:[.092,.021,.012],scattering:[.0025,.0045,.005],
 waterLight:[.07,.28,.32],exposure:1.12};
PRESETS.ripples = {...PRESETS.shallows,name:'Ripple interference',
 description:'Local impulses / overlapping waves / refracted light',
 hs:.045,period:1.7,wind:.7,roughness:.029};
PRESETS.bubbles = {...PRESETS.shallows,name:'Bubbles in sunlight',
 description:'Buoyant secondary particles / wavelength-dependent attenuation',
 hs:.18,period:1.9,bubbleEmitter:[1,-2.5,-2]};


// Energy-normalized crossing seas: amplitudes are NOT multiplied by arbitrary per-band gains.
function seaSystems(period,direction,windFraction=.075,crossFraction=.20){
 return [
  {period,direction,fraction:1-windFraction-crossFraction,gamma:4.2,spread:22},
  {period:period*1.37,direction:direction+.83,fraction:crossFraction,gamma:2.4,spread:12},
  {period:period*.43,direction:direction-.22,fraction:windFraction,gamma:1.3,spread:3}
 ];
}
Object.assign(PRESETS.blue,{name:'Atlantic / crossing seas',hs:4.8,period:9.2,chop:.72,roughness:.105,wind:12,foamThreshold:.65,foamGain:3.2,foamLifetime:12,waterLight:[.08,.32,.31],description:'Energy-balanced swell + crossing sea + short wind waves / persistent whitewater'});
Object.assign(PRESETS.storm,{name:'Gale / breaking crests',hs:8.2,period:10.8,chop:.52,roughness:.13,wind:23,foamThreshold:.69,foamGain:4.7,foamLifetime:16,exposure:1.08,waterLight:[.06,.22,.22],description:'Steeper multiscale crests / wind-driven spray / aged foam trails'});
Object.assign(PRESETS.swell,{name:'Ocean swell / long-period energy',hs:6.3,period:13.2,chop:.80,foamThreshold:.61,foamGain:2.8,foamLifetime:11});
Object.assign(PRESETS.dawn,{hs:3.7,period:9.4,chop:.74,foamThreshold:.64,foamGain:2.6,foamLifetime:11});
for(const k of ['blue','dawn','storm','swell','silver','afterglow']){
 const p=PRESETS[k];p.seaSystems=seaSystems(p.period,p.direction,k==='storm'?.12:k==='swell'?.025:.065,k==='swell'?.12:.20);
}
PRESETS.whitewater={...PRESETS.blue,name:'Whitewater / surface study',roughness:.11,hs:5.9,period:8.4,chop:.46,wind:17,foamThreshold:.72,foamGain:4.6,foamLifetime:17,seaSystems:seaSystems(8.4,-.55,.12,.14),description:'Fresh crest aeration → porous rafts → elongated residual foam'};

return {PRESETS,FIXED_DT,SEED};
})();
