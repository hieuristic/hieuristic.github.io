import { Chargine, CookTorranceShader } from './chargine.js';

const DEBUG = false;

const canvas = document.getElementById('screen_canvas');
const engine = new Chargine(canvas);

// Atmosphere parameters (can be adjusted via slider in DEBUG mode)
let atmosphereScale = 3.5; // Atmosphere radius = planet radius * scale
let atmosphereDensity = 2.5; // Atmosphere density/thickness multiplier

// Zoom mode
let zoomIn = false;
let zoomTransition = 0.0; // 0 = zoomed out, 1 = zoomed in
let targetZoom = 0.0; // Target zoom state for animation
const ZOOM_SPEED = 2.0; // Transition speed

// Point of interest (latitude, longitude in radians) - Default: Hanoi, Vietnam
let POI_LAT = 21.0285 * Math.PI / 180;
let POI_LON = 105.8542 * Math.PI / 180;

// Get current location if available
if ("geolocation" in navigator) {
    navigator.geolocation.getCurrentPosition((position) => {
        const lat = position.coords.latitude;
        const lon = position.coords.longitude;
        console.log(`Current location: Lat ${lat}, Lon ${lon}`);

        // Update POI to current location
        POI_LAT = lat * Math.PI / 180;
        POI_LON = lon * Math.PI / 180;
    }, (error) => {
        console.warn("Geolocation access denied or failed:", error.message);
    });
} else {
    console.log("Geolocation is not supported by this browser.");
}

// Shape mode
let shapeIndex = 0; // 0 = sphere, 1 = cube, 2 = torus
let shapeWeights = [1, 0, 0]; // x=sphere, y=cube, z=torus
const SHAPE_SPEED = 3.0;

// Lerp helper function
function lerp(a, b, t) {
    return a + (b - a) * t;
}

function smoothstep(t) {
    return t * t * (3 - 2 * t);
}

const shaderCode = CookTorranceShader + `
struct VSOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex : u32) -> VSOutput {
    var pos = array<vec2f, 6>(
        vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
        vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
    );

    var output: VSOutput;
    output.position = vec4f(pos[vertexIndex], 0.0, 1.0);
    output.uv = pos[vertexIndex] * 0.5 + 0.5;
    return output;
}

struct Uniforms {
    time: f32,
    atmosphereScale: f32,
    atmosphereDensity: f32,
    zoomIn: f32,
    resolution: vec2f,
    cameraPos: vec3f,
    orthoScale: f32,
    shapeWeights: vec3f,
    _pad4: f32,
    lightPos: vec3f,
    _pad5: f32,
    cameraTarget: vec3f,
    _pad2: f32,
};

@group(0) @binding(0) var mySampler: sampler;
@group(0) @binding(1) var myTexture: texture_2d<f32>;
@group(0) @binding(2) var specularMap: texture_2d<f32>;
@group(0) @binding(3) var nightTexture: texture_2d<f32>;
@group(0) @binding(4) var heightMap: texture_2d<f32>;
@group(0) @binding(5) var<uniform> uniforms: Uniforms;

const PI: f32 = 3.14159265359;
const PLANET_RADIUS: f32 = 1.0;

// Rayleigh scattering coefficients (wavelength dependent - RGB)
const RAYLEIGH_COEFFS: vec3f = vec3f(5.8e-3, 13.5e-3, 33.1e-3); // Adjusted for visual effect
const RAYLEIGH_SCALE_HEIGHT: f32 = 0.1; // Scale height relative to planet radius

fn sphereSDF(p: vec3f, r: f32) -> f32 {
    return length(p) - r;
}

fn cubeSDF(p: vec3f, size: f32) -> f32 {
    let d = abs(p) - vec3f(size);
    return length(max(d, vec3f(0.0))) + min(max(d.x, max(d.y, d.z)), 0.0);
}

fn torusSDF(p: vec3f, t: vec2f) -> f32 {
    let q = vec2f(length(p.xz) - t.x, p.y);
    return length(q) - t.y;
}

fn sceneSDF(p: vec3f, r: f32) -> f32 {
    let sphereDist = sphereSDF(p, r);
    let cubeDist = cubeSDF(p, r * 0.8);
    // Torus with slightly larger major radius for clearer donut shape
    let torusDist = torusSDF(p, vec2f(r * 0.9, r * 0.2));
    
    return dot(uniforms.shapeWeights, vec3f(sphereDist, cubeDist, torusDist));
}

// Ray-sphere intersection, returns (near, far) distances, or (-1, -1) if no hit
fn raySphereIntersect(ro: vec3f, rd: vec3f, radius: f32) -> vec2f {
    let b = dot(ro, rd);
    let c = dot(ro, ro) - radius * radius;
    let discriminant = b * b - c;
    
    if (discriminant < 0.0) {
        return vec2f(-1.0, -1.0);
    }
    
    let sqrtD = sqrt(discriminant);
    return vec2f(-b - sqrtD, -b + sqrtD);
}

// Ray-intersection for atmosphere: use a conservative sphere that covers both shapes
fn raySceneIntersect(ro: vec3f, rd: vec3f, radius: f32) -> vec2f {
    // Both sphere and cube atmospheres are contained within a sphere of radius * 1.5
    return raySphereIntersect(ro, rd, radius * 1.5);
}

// Calculate normal using SDF gradient
fn calculateNormal(p: vec3f) -> vec3f {
    let e = vec2f(0.001, 0.0);
    return normalize(vec3f(
        sceneSDF(p + e.xyy, PLANET_RADIUS) - sceneSDF(p - e.xyy, PLANET_RADIUS),
        sceneSDF(p + e.yxy, PLANET_RADIUS) - sceneSDF(p - e.yxy, PLANET_RADIUS),
        sceneSDF(p + e.yyx, PLANET_RADIUS) - sceneSDF(p - e.yyx, PLANET_RADIUS)
    ));
}

// Calculate atmospheric density at a point (exponential falloff)
// Uses blended SDF distance for shape-following atmosphere
fn atmosphereDensity(p: vec3f, atmosphereRadius: f32) -> f32 {
    let sphereDist = length(p) - PLANET_RADIUS;
    let cubeDist = cubeSDF(p, PLANET_RADIUS * 0.8);
    let torusDist = torusSDF(p, vec2f(PLANET_RADIUS * 0.9, PLANET_RADIUS * 0.2));
    
    let altitude = dot(uniforms.shapeWeights, vec3f(sphereDist, cubeDist, torusDist));
    
    let thickness = (atmosphereRadius - PLANET_RADIUS);
    if (altitude < 0.0 || altitude > thickness) {
        return 0.0;
    }
    
    let normalizedAltitude = altitude / thickness;
    let scaleHeight = 0.25;
    return exp(-normalizedAltitude * 4.0 / scaleHeight) * (1.0 - normalizedAltitude * normalizedAltitude);
}

// Rayleigh phase function
fn rayleighPhase(cosTheta: f32) -> f32 {
    return 3.0 / (16.0 * PI) * (1.0 + cosTheta * cosTheta);
}

// Calculate optical depth along a ray segment through atmosphere
fn opticalDepth(ro: vec3f, rd: vec3f, rayLength: f32, atmosphereRadius: f32, numSamples: i32) -> f32 {
    let stepSize = rayLength / f32(numSamples);
    var optDepth = 0.0;
    
    for (var i = 0; i < numSamples; i++) {
        let samplePos = ro + rd * (f32(i) + 0.5) * stepSize;
        optDepth += atmosphereDensity(samplePos, atmosphereRadius) * stepSize;
    }
    
    return optDepth;
}

// Calculate scattered light color using Rayleigh scattering
fn calculateScattering(ro: vec3f, rd: vec3f, rayLength: f32, atmosphereRadius: f32, planetHit: bool) -> vec3f {
    let numSamples = 16;
    let stepSize = rayLength / f32(numSamples);
    
    // Light is distant for scattering purposes, treat as directional from center to point light
    let lightDir = normalize(uniforms.lightPos);
    
    var scatteredLight = vec3f(0.0);
    var opticalDepthAccum = 0.0;
    
    let cosTheta = dot(rd, lightDir);
    let phase = rayleighPhase(cosTheta);
    
    for (var i = 0; i < numSamples; i++) {
        let samplePos = ro + rd * (f32(i) + 0.5) * stepSize;
        let density = atmosphereDensity(samplePos, atmosphereRadius);
        
        opticalDepthAccum += density * stepSize;
        
        // Simplified in-scattering (no secondary ray march for performance)
        let transmittance = exp(-RAYLEIGH_COEFFS * opticalDepthAccum * 2.0);
        let localScatter = density * RAYLEIGH_COEFFS * phase * stepSize;
        
        // Soft shadowing: check if the planet occludes the light from this sample point
        let lightVecSample = uniforms.lightPos - samplePos;
        let shadowRayDir = normalize(lightVecSample);
        let lightDist = length(lightVecSample);
        
        let b = dot(samplePos, shadowRayDir);
        let distSq = dot(samplePos, samplePos) - b * b;
        let distToCenter = sqrt(max(0.0, distSq));
        
        var shadow = 1.0;
        if (b < 0.0 && -b < lightDist) {
            // Transition from full shadow to no shadow at the planet's edge
            shadow = smoothstep(0.8, 1.02, distToCenter);
        }
        
        scatteredLight += transmittance * localScatter * shadow;
    }
    
    return scatteredLight * 100.0 * uniforms.atmosphereDensity; // Reverted Intensity multiplier
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    // Correct aspect ratio
    var coord = (uv * 2.0 - 1.0);
    coord.x = coord.x * (uniforms.resolution.x / uniforms.resolution.y);
    
    // Build camera orientation
    let forward = normalize(uniforms.cameraTarget - uniforms.cameraPos);
    let right = normalize(cross(vec3f(0.0, 1.0, 0.0), forward));
    let up = cross(forward, right);
    
    // Point light direction and distance
    // Orthographic projection: parallel rays, offset origin
    let rayOriginOffset = right * coord.x * uniforms.orthoScale + up * coord.y * uniforms.orthoScale;
    let ro = uniforms.cameraPos + rayOriginOffset;
    let rd = forward; // All rays parallel in orthographic
    
    let atmosphereRadius = PLANET_RADIUS * uniforms.atmosphereScale;

    // Raymarching for planet
    var t = 0.0;
    var hit = false;
    var p = vec3f(0.0);
    
    for(var i = 0; i < 64; i++) {
        p = ro + rd * t;
        let d = sceneSDF(p, PLANET_RADIUS);
        
        if (d < 0.001) {
            hit = true;
            break;
        }
        
        t += d;
        if (t > 10.0) { break; }
    }

    // Compute normal and UV mapping
    var n = normalize(p); // Fallback
    if (hit) {
        n = calculateNormal(p);
    }
    
    let normDir = normalize(p);
    
    // Sphere/Cube UVs: equirectangular
    let sphereAngle = atan2(normDir.z, normDir.x);
    let sphereU = (sphereAngle / (2.0 * PI)) + 0.5; 
    let sphereV = 1.0 - (acos(-normDir.y) / PI); 

    // Torus UVs: pole angle and cross-section angle
    let angleXZ = atan2(p.z, p.x);
    let torusU = angleXZ / (2.0 * PI) + 0.5;
    let majorRadius = PLANET_RADIUS * 0.9;
    let p_proj = normalize(vec3f(p.x, 0.0, p.z)) * majorRadius;
    let p_rel = p - p_proj;
    let angleCross = atan2(p_rel.y, length(p.xz) - majorRadius);
    let torusV = angleCross / (2.0 * PI) + 0.5;

    // Blend UV coordinates based on torus influence
    let u = mix(sphereU, torusU, uniforms.shapeWeights.z);
    let v = mix(sphereV, torusV, uniforms.shapeWeights.z);
    
    let texUV = vec2f(u, v);
    var ddxUV = dpdx(texUV);
    var ddyUV = dpdy(texUV);

    // Filter out the large derivative jumps at the 0-1 wrap seam to prevent mipmap artifacts
    ddxUV = ddxUV - round(ddxUV);
    ddyUV = ddyUV - round(ddyUV);
    
    // Atmosphere intersection (uses blended shape)
    let atmoHit = raySceneIntersect(ro, rd, atmosphereRadius);
    var atmosphereColor = vec3f(0.0);
    
    if (atmoHit.y > 0.0) {
        let atmoStart = max(0.0, atmoHit.x);
        var atmoEnd = atmoHit.y;
        
        // If we hit the planet, atmosphere ends at planet surface
        if (hit) {
            atmoEnd = min(atmoEnd, t);
        }
        
        let atmoRayLength = atmoEnd - atmoStart;
        if (atmoRayLength > 0.0) {
            let atmoRayOrigin = ro + rd * atmoStart;
            atmosphereColor = calculateScattering(atmoRayOrigin, rd, atmoRayLength, atmosphereRadius, hit);
        }
    }

    if (hit) {
        let texColor = textureSampleGrad(myTexture, mySampler, texUV, ddxUV, ddyUV);
        let specularIntensity = textureSampleGrad(specularMap, mySampler, texUV, ddxUV, ddyUV).r;
        
        // Calculate normal
        let n_geom = n;
        
        // Bump mapping from height map
        let h = textureSampleGrad(heightMap, mySampler, texUV, ddxUV, ddyUV).r;
        let uv_offset = 0.001;
        let h_u = (textureSampleGrad(heightMap, mySampler, texUV + vec2f(uv_offset, 0.0), ddxUV, ddyUV).r - h) / uv_offset;
        let h_v = (textureSampleGrad(heightMap, mySampler, texUV + vec2f(0.0, uv_offset), ddxUV, ddyUV).r - h) / uv_offset;
        
        // Local tangent space
        var tangent = normalize(cross(vec3f(0.0, 1.0, 0.0), n_geom));
        if (length(tangent) < 0.1) { tangent = normalize(cross(vec3f(1.0, 0.0, 0.0), n_geom)); }
        let bitangent = cross(n_geom, tangent);
        
        // Perturb normal based on height gradient
        let bumpStrength = 0.05; 
        let n_bump = normalize(n_geom + bumpStrength * (h_u * tangent + h_v * bitangent));
        
        // Use bumped normal for lighting
        let n_lit = n_bump;

        // Lighting setup
        let viewDir = -rd;
        let lightColor = vec3f(1.0, 1.0, 1.0);
        
        let lightVec = uniforms.lightPos - p;
        let lightDist = length(lightVec);
        let surfLightDir = normalize(lightVec);
        let falloff = 25.0 / (lightDist * lightDist); // Boosted Point light falloff
        
        // Ambient (black)
        let ambient = vec3f(0.0);
        
        // Diffuse
        let NdotL = max(dot(n_lit, surfLightDir), 0.0);
        let diffuse = NdotL * lightColor * falloff;
        
        // Cook-Torrance Specular (modulated by specular map)
        let roughness = mix(0.8, 0.2, specularIntensity);
        let F0 = vec3f(mix(0.02, 0.1, specularIntensity));
        let specular = cookTorranceSpecular(n_lit, viewDir, surfLightDir, roughness, F0) * NdotL * specularIntensity * lightColor * 50.0 * falloff;
        
        // Day/Night blending and Emittance
        let nightColor = textureSampleGrad(nightTexture, mySampler, texUV, ddxUV, ddyUV);
        let dayWeight = smoothstep(-0.2, 0.1, dot(n_lit, surfLightDir));
        
        // City lights act as emittance on the dark side
        // Use pow to sharpen lights and suppress any background noise/ocean glow in the texture
        let emissive = pow(nightColor.rgb, vec3f(2.0)) * (1.0 - dayWeight) * 8.0;
        
        // Combine surface lighting with emissive city lights
        let surfaceColor = texColor.rgb * (ambient + diffuse * 0.7) + specular * dayWeight + emissive;
        let finalColor = surfaceColor + atmosphereColor;
        
        return vec4f(finalColor, 1.0);
    }

    // Sky only (atmosphere without planet hit)
    // Blend atmosphere over background based on scattering intensity
    let bgColor = vec3f(0.0, 0.0, 0.0); // Black background
    let atmoStrength = clamp(length(atmosphereColor), 0.0, 1.0);
    let skyColor = mix(bgColor, atmosphereColor, atmoStrength);
    return vec4f(skyColor, 1.0);
}
`;

async function main() {
    try {
        const device = await engine.init();
        const texture = await engine.loadTexture('assets/earth_texture.jpeg');
        const specularTexture = await engine.loadTexture('assets/earth_texture_specular.avif');
        const nightTexture = await engine.loadTexture('assets/earth_night_texture.jpg');
        const heightTexture = await engine.loadTexture('assets/earth_height_texture.png');
        const sampler = engine.createSampler({
            addressModeU: 'repeat',
            addressModeV: 'clamp-to-edge',
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
        });

        // Uniform buffer: 48 bytes
        // time(f32) + atmosphereScale(f32) + atmosphereDensity(f32) + zoomIn(f32) = 16 bytes
        // resolution(vec2f) + pad(vec2f) = 16 bytes  
        // cameraPos(vec3f) + pad(f32) = 16 bytes
        // shapeWeights(vec3f) + pad(f32) = 16 bytes
        // lightPos(vec3f) + pad(f32) = 16 bytes
        // cameraTarget(vec3f) + pad(f32) = 16 bytes
        const uniformBufferSize = 96;
        const uniformBuffer = device.createBuffer({
            size: uniformBufferSize,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const bindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
                { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
                { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ]
        });

        const pipeline = await engine.createScreenQuadPipeline(shaderCode, [bindGroupLayout]);

        const bindGroup = device.createBindGroup({
            layout: bindGroupLayout,
            entries: [
                { binding: 0, resource: sampler },
                { binding: 1, resource: texture.createView() },
                { binding: 2, resource: specularTexture.createView() },
                { binding: 3, resource: nightTexture.createView() },
                { binding: 4, resource: heightTexture.createView() },
                { binding: 5, resource: { buffer: uniformBuffer } },
            ]
        });

        // DEBUG UI: Atmosphere sliders
        if (DEBUG) {
            const debugPanel = document.createElement('div');
            debugPanel.style.cssText = 'position: absolute; top: 10px; left: 10px; background: rgba(0,0,0,0.7); padding: 15px; border-radius: 8px; color: white; font-family: monospace;';
            debugPanel.innerHTML = `
                <div style="margin-bottom: 8px; font-weight: bold;">DEBUG Controls</div>
                <label>Atmosphere Scale: <span id="atmoValue">${atmosphereScale.toFixed(2)}</span></label><br>
                <input type="range" id="atmoSlider" min="1.0" max="10.0" step="0.1" value="${atmosphereScale}" style="width: 200px; margin-top: 5px;"><br><br>
                <label>Atmosphere Density: <span id="densityValue">${atmosphereDensity.toFixed(2)}</span></label><br>
                <input type="range" id="densitySlider" min="0.1" max="5.0" step="0.1" value="${atmosphereDensity}" style="width: 200px; margin-top: 5px;">
            `;
            document.body.appendChild(debugPanel);

            document.getElementById('atmoSlider').addEventListener('input', (e) => {
                atmosphereScale = parseFloat(e.target.value);
                document.getElementById('atmoValue').textContent = atmosphereScale.toFixed(2);
            });
            document.getElementById('densitySlider').addEventListener('input', (e) => {
                atmosphereDensity = parseFloat(e.target.value);
                document.getElementById('densityValue').textContent = atmosphereDensity.toFixed(2);
            });
        }

        // Zoom toggle button
        const zoomButton = document.createElement('button');
        zoomButton.id = 'zoomToggle';
        zoomButton.style.cssText = `
            position: absolute; 
            top: 20px; 
            left: calc(50% + 0.25rem); 
            width: 1.5rem; 
            height: 1.5rem; 
            cursor: pointer; 
            background: #505050; 
            border: none; 
            margin: 0; 
            padding: 0; 
            display: flex; 
            align-items: center; 
            justify-content: center; 
            transition: all 0.2s ease; 
            overflow: hidden;
            box-sizing: border-box;
        `;
        const urlParams = new URLSearchParams(window.location.search);
        const showUI = urlParams.get('ui') !== 'hide';

        if (showUI) {
            zoomButton.innerHTML = `<img src="assets/mappin.svg" style="width: 70%; height: 70%; object-fit: contain;">`;
            document.body.appendChild(zoomButton);
        }

        zoomButton.addEventListener('mouseenter', () => {
            zoomButton.style.background = '#666';
        });
        zoomButton.addEventListener('mouseleave', () => {
            zoomButton.style.background = '#505050';
        });

        zoomButton.addEventListener('click', () => {
            zoomIn = !zoomIn;
        });

        // Shape toggle button
        const shapeButton = document.createElement('button');
        shapeButton.id = 'shapeToggle';
        shapeButton.style.cssText = `
            position: absolute; 
            top: 20px; 
            left: calc(50% - 1.75rem); 
            width: 1.5rem; 
            height: 1.5rem; 
            cursor: pointer; 
            background: #505050; 
            border: none; 
            margin: 0; 
            padding: 0; 
            display: flex; 
            align-items: center; 
            justify-content: center; 
            transition: all 0.2s ease; 
            overflow: hidden;
            box-sizing: border-box;
        `;

        const updateShapeIcon = () => {
            const nextShape = (shapeIndex + 1) % 3;
            const icons = ['sphere.svg', 'cube.svg', 'torus.svg'];
            shapeButton.innerHTML = `<img src="assets/${icons[nextShape]}" style="width: 70%; height: 70%; object-fit: contain;">`;
        };
        if (showUI) {
            updateShapeIcon();
            document.body.appendChild(shapeButton);
        }

        shapeButton.addEventListener('mouseenter', () => {
            shapeButton.style.background = '#666';
        });
        shapeButton.addEventListener('mouseleave', () => {
            shapeButton.style.background = '#505050';
        });

        shapeButton.addEventListener('click', () => {
            shapeIndex = (shapeIndex + 1) % 3;
            updateShapeIcon();
        });

        function frame(time) {
            const t = time * 0.001;

            // Update Uniforms
            const canvasWidth = canvas.clientWidth;
            const canvasHeight = canvas.clientHeight;

            // Resize engine (handles MSAA texture resizing too)
            const dpr = 2.0;
            engine.resize(canvasWidth * dpr, canvasHeight * dpr);

            // Calculate camera position based on zoom mode
            let camX, camY, camZ, targetX, targetY, targetZ;
            let zoomOutCamX, zoomOutCamY, zoomOutCamZ;
            let zoomOutTargetX, zoomOutTargetY, zoomOutTargetZ;
            let zoomInCamX, zoomInCamY, zoomInCamZ;
            let zoomInTargetX, zoomInTargetY, zoomInTargetZ;

            // Animate zoom transition
            targetZoom = zoomIn ? 1.0 : 0.0;
            const dt = 0.016; // Approximate frame time
            if (zoomTransition < targetZoom) {
                zoomTransition = Math.min(zoomTransition + dt * ZOOM_SPEED, targetZoom);
            } else if (zoomTransition > targetZoom) {
                zoomTransition = Math.max(zoomTransition - dt * ZOOM_SPEED, targetZoom);
            }
            const smoothZoom = smoothstep(zoomTransition);

            // Animate shape weights
            for (let i = 0; i < 3; i++) {
                const targetWeight = (shapeIndex === i) ? 1.0 : 0.0;
                if (shapeWeights[i] < targetWeight) {
                    shapeWeights[i] = Math.min(shapeWeights[i] + dt * SHAPE_SPEED, targetWeight);
                } else if (shapeWeights[i] > targetWeight) {
                    shapeWeights[i] = Math.max(shapeWeights[i] - dt * SHAPE_SPEED, targetWeight);
                }
            }
            // Normalize weights during transition
            const totalWeight = shapeWeights[0] + shapeWeights[1] + shapeWeights[2];
            const renderWeights = shapeWeights.map(w => w / (totalWeight || 1.0));

            // Camera rotation speed
            const cameraRotation = t * 0.1; // Same speed as old texture rotation

            // Slow orbit around POI - clockwise rotation around axis from center to POI
            // Camera orbit speed (only for zoom out)

            // POI position on sphere surface (fixed texture coordinates)
            const poiX = Math.cos(POI_LAT) * Math.cos(POI_LON);
            const poiY = Math.sin(POI_LAT);
            const poiZ = Math.cos(POI_LAT) * Math.sin(POI_LON);

            // POI normal (axis of rotation) - points from center to POI
            const poiLen = Math.sqrt(poiX * poiX + poiY * poiY + poiZ * poiZ);
            const axisX = poiX / poiLen;
            const axisY = poiY / poiLen;
            const axisZ = poiZ / poiLen;

            // Zoom out camera: rotates around a tilted axis
            const zoomOutDist = 3.0;
            const tiltAxis = { x: 0.3, y: 0.9, z: 0.3 };
            const tiltLen = Math.sqrt(tiltAxis.x * tiltAxis.x + tiltAxis.y * tiltAxis.y + tiltAxis.z * tiltAxis.z);
            const axisX_out = tiltAxis.x / tiltLen;
            const axisY_out = tiltAxis.y / tiltLen;
            const axisZ_out = tiltAxis.z / tiltLen;

            let perpX_out, perpY_out, perpZ_out;
            if (Math.abs(axisY_out) < 0.99) {
                perpX_out = axisZ_out; perpY_out = 0; perpZ_out = -axisX_out;
            } else {
                perpX_out = 1; perpY_out = 0; perpZ_out = 0;
            }
            const perpLen_out = Math.sqrt(perpX_out * perpX_out + perpY_out * perpY_out + perpZ_out * perpZ_out);
            perpX_out /= perpLen_out; perpY_out /= perpLen_out; perpZ_out /= perpLen_out;

            const perp2X_out = axisY_out * perpZ_out - axisZ_out * perpY_out;
            const perp2Y_out = axisZ_out * perpX_out - axisX_out * perpZ_out;
            const perp2Z_out = axisX_out * perpY_out - axisY_out * perpX_out;

            zoomOutCamX = (Math.cos(cameraRotation) * perpX_out + Math.sin(cameraRotation) * perp2X_out) * zoomOutDist;
            zoomOutCamY = (Math.cos(cameraRotation) * perpY_out + Math.sin(cameraRotation) * perp2Y_out) * zoomOutDist;
            zoomOutCamZ = (Math.cos(cameraRotation) * perpZ_out + Math.sin(cameraRotation) * perp2Z_out) * zoomOutDist;

            zoomOutTargetX = 0.0;
            zoomOutTargetY = 0.0;
            zoomOutTargetZ = 0.0;

            // --- Light Orbit Calculation ---
            const lightRotation = t * 0.5; // Orbit speed
            const lightOrbitDist = 5.0;
            const lightTiltAxis = { x: -0.5, y: 0.8, z: -0.2 };
            const lightTiltLen = Math.sqrt(lightTiltAxis.x * lightTiltAxis.x + lightTiltAxis.y * lightTiltAxis.y + lightTiltAxis.z * lightTiltAxis.z);
            const lAxisX = lightTiltAxis.x / lightTiltLen;
            const lAxisY = lightTiltAxis.y / lightTiltLen;
            const lAxisZ = lightTiltAxis.z / lightTiltLen;

            let lPerpX, lPerpY, lPerpZ;
            if (Math.abs(lAxisY) < 0.99) {
                lPerpX = lAxisZ; lPerpY = 0; lPerpZ = -lAxisX;
            } else {
                lPerpX = 1; lPerpY = 0; lPerpZ = 0;
            }
            const lPerpLen = Math.sqrt(lPerpX * lPerpX + lPerpY * lPerpY + lPerpZ * lPerpZ);
            lPerpX /= lPerpLen; lPerpY /= lPerpLen; lPerpZ /= lPerpLen;

            const lPerp2X = lAxisY * lPerpZ - lAxisZ * lPerpY;
            const lPerp2Y = lAxisZ * lPerpX - lAxisX * lPerpZ;
            const lPerp2Z = lAxisX * lPerpY - lAxisY * lPerpX;

            const lightX = (Math.cos(lightRotation) * lPerpX + Math.sin(lightRotation) * lPerp2X) * lightOrbitDist;
            const lightY = (Math.cos(lightRotation) * lPerpY + Math.sin(lightRotation) * lPerp2Y) * lightOrbitDist;
            const lightZ = (Math.cos(lightRotation) * lPerpZ + Math.sin(lightRotation) * lPerp2Z) * lightOrbitDist;
            // -------------------------------

            // Zoom in camera: positioned outside, orbiting around POI axis
            const zoomDist = 1.8; // Distance from planet center

            // Create a vector perpendicular to the POI axis for orbit
            // Use world up to find perpendicular, unless POI is at pole
            let perpX, perpY, perpZ;
            if (Math.abs(axisY) < 0.99) {
                // Cross product with world up (0, 1, 0)
                perpX = axisZ;
                perpY = 0;
                perpZ = -axisX;
            } else {
                // POI near pole, use world forward
                perpX = 1;
                perpY = 0;
                perpZ = 0;
            }
            const perpLen = Math.sqrt(perpX * perpX + perpY * perpY + perpZ * perpZ);
            perpX /= perpLen;
            perpY /= perpLen;
            perpZ /= perpLen;

            // Second perpendicular vector (cross of axis and perp)
            const perp2X = axisY * perpZ - axisZ * perpY;
            const perp2Y = axisZ * perpX - axisX * perpZ;
            const perp2Z = axisX * perpY - axisY * perpX;

            // Fixed camera offset for zoom-in mode (no longer orbiting)
            const orbitRadius = 0.6;
            const fixedOrbitAngle = 0.5; // Constant angle for a nice perspective
            const camOffsetX = (Math.cos(fixedOrbitAngle) * perpX + Math.sin(fixedOrbitAngle) * perp2X) * orbitRadius;
            const camOffsetY = (Math.cos(fixedOrbitAngle) * perpY + Math.sin(fixedOrbitAngle) * perp2Y) * orbitRadius;
            const camOffsetZ = (Math.cos(fixedOrbitAngle) * perpZ + Math.sin(fixedOrbitAngle) * perp2Z) * orbitRadius;

            // Camera position: slightly offset from POI to show the horizon
            const zoomInDist = 1.5;
            zoomInCamX = axisX * zoomInDist + camOffsetX;
            zoomInCamY = axisY * zoomInDist + camOffsetY;
            zoomInCamZ = axisZ * zoomInDist + camOffsetZ;

            // Look at a point slightly past the POI to center the horizon
            zoomInTargetX = poiX * 0.9;
            zoomInTargetY = poiY * 0.9;
            zoomInTargetZ = poiZ * 0.9;

            // Interpolate between zoom states
            camX = lerp(zoomOutCamX, zoomInCamX, smoothZoom);
            camY = lerp(zoomOutCamY, zoomInCamY, smoothZoom);
            camZ = lerp(zoomOutCamZ, zoomInCamZ, smoothZoom);
            const smoothOrtho = lerp(2.2, 0.7, smoothZoom);

            targetX = lerp(zoomOutTargetX, zoomInTargetX, smoothZoom);
            targetY = lerp(zoomOutTargetY, zoomInTargetY, smoothZoom);
            targetZ = lerp(zoomOutTargetZ, zoomInTargetZ, smoothZoom);

            const uniformData = new Float32Array([
                t, atmosphereScale, atmosphereDensity, zoomIn ? 1.0 : 0.0,
                canvasWidth, canvasHeight, 0, 0,
                camX, camY, camZ, smoothOrtho,
                renderWeights[0], renderWeights[1], renderWeights[2], 0,
                lightX, lightY, lightZ, 0,
                targetX, targetY, targetZ, 0
            ]);
            device.queue.writeBuffer(uniformBuffer, 0, uniformData);

            const commandEncoder = device.createCommandEncoder();
            const textureView = engine.context.getCurrentTexture().createView();

            const renderPassDescriptor = engine.getRenderPassDescriptor(textureView, { r: 0.0, g: 0.0, b: 0.0, a: 1.0 });
            const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);

            passEncoder.setPipeline(pipeline);
            passEncoder.setBindGroup(0, bindGroup);
            passEncoder.draw(6);
            passEncoder.end();

            device.queue.submit([commandEncoder.finish()]);
            requestAnimationFrame(frame);
        }

        requestAnimationFrame(frame);

    } catch (e) {
        console.error("WebGPU Error:", e);
        const errorDiv = document.createElement('div');
        errorDiv.style.position = 'absolute';
        errorDiv.style.top = '0';
        errorDiv.style.left = '0';
        errorDiv.style.color = 'red';
        errorDiv.style.background = 'rgba(0,0,0,0.8)';
        errorDiv.style.padding = '20px';
        errorDiv.innerText = `WebGPU Error: ${e.message}`;
        document.body.appendChild(errorDiv);
        throw e;
    }
}

main();
