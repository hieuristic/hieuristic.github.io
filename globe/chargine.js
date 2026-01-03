// Cook-Torrance BRDF shader functions (WGSL)
export const CookTorranceShader = `
// Normal Distribution Function (GGX/Trowbridge-Reitz)
fn D_GGX(NdotH: f32, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let NdotH2 = NdotH * NdotH;
    let denom = NdotH2 * (a2 - 1.0) + 1.0;
    return a2 / (3.14159 * denom * denom);
}

// Fresnel (Schlick approximation)
fn F_Schlick(cosTheta: f32, F0: vec3f) -> vec3f {
    return F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
}

// Geometry function (Smith's method with GGX)
fn G_SmithGGX(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
    let r = roughness + 1.0;
    let k = (r * r) / 8.0;
    let ggx1 = NdotV / (NdotV * (1.0 - k) + k);
    let ggx2 = NdotL / (NdotL * (1.0 - k) + k);
    return ggx1 * ggx2;
}

// Cook-Torrance specular BRDF
// N: surface normal, V: view direction, L: light direction
// roughness: 0.0 (smooth) to 1.0 (rough)
// F0: base reflectivity (e.g. vec3f(0.04) for dielectrics, higher for metals)
fn cookTorranceSpecular(N: vec3f, V: vec3f, L: vec3f, roughness: f32, F0: vec3f) -> vec3f {
    let H = normalize(V + L);
    
    let NdotV = max(dot(N, V), 0.001);
    let NdotL = max(dot(N, L), 0.0);
    let NdotH = max(dot(N, H), 0.0);
    let VdotH = max(dot(V, H), 0.0);
    
    let D = D_GGX(NdotH, roughness);
    let F = F_Schlick(VdotH, F0);
    let G = G_SmithGGX(NdotV, NdotL, roughness);
    
    let numerator = D * F * G;
    let denominator = 4.0 * NdotV * NdotL + 0.001;
    
    return numerator / denominator;
}
`;

export class Chargine {
    constructor(canvas) {
        this.canvas = canvas;
        this.adapter = null;
        this.device = null;
        this.context = null;
        this.format = navigator.gpu ? navigator.gpu.getPreferredCanvasFormat() : 'bgra8unorm';
        this.sampleCount = 1;
        this.msaaTexture = null;
        this.currentWidth = canvas.width;
        this.currentHeight = canvas.height;
    }

    async init() {
        if (!navigator.gpu) {
            throw new Error("WebGPU not supported on this browser.");
        }

        this.adapter = await navigator.gpu.requestAdapter();
        if (!this.adapter) {
            throw new Error("No WebGPU adapter found.");
        }

        this.device = await this.adapter.requestDevice();
        this.context = this.canvas.getContext("webgpu");

        this.context.configure({
            device: this.device,
            format: this.format,
            alphaMode: 'premultiplied',
        });

        this.resize(this.canvas.width, this.canvas.height);

        return this.device;
    }

    generateMipmaps(texture) {
        const pipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: this.device.createShaderModule({
                    code: `
                        struct VSOutput {
                            @builtin(position) position: vec4f,
                            @location(0) texCoord: vec2f,
                        };
                        @vertex
                        fn vs_main(@builtin(vertex_index) vertexIndex : u32) -> VSOutput {
                            var pos = array<vec2f, 6>(
                                vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
                                vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
                            );
                            var output: VSOutput;
                            output.position = vec4f(pos[vertexIndex], 0.0, 1.0);
                            output.texCoord = pos[vertexIndex] * vec2f(0.5, -0.5) + vec2f(0.5, 0.5);
                            return output;
                        }
                    `,
                }),
                entryPoint: 'vs_main',
            },
            fragment: {
                module: this.device.createShaderModule({
                    code: `
                        @group(0) @binding(0) var imgSampler: sampler;
                        @group(0) @binding(1) var img: texture_2d<f32>;
                        @fragment
                        fn fs_main(@location(0) texCoord: vec2f) -> @location(0) vec4f {
                            return textureSample(img, imgSampler, texCoord);
                        }
                    `,
                }),
                entryPoint: 'fs_main',
                targets: [{ format: texture.format }],
            },
            primitive: { topology: 'triangle-list' },
        });

        const sampler = this.device.createSampler({ minFilter: 'linear' });

        // Loop through mip levels
        let currentwidth = texture.width;
        let currentheight = texture.height;

        for (let i = 1; i < texture.mipLevelCount; ++i) {
            const bindGroup = this.device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: sampler },
                    { binding: 1, resource: texture.createView({ baseMipLevel: i - 1, mipLevelCount: 1 }) },
                ],
            });

            currentwidth = Math.max(1, Math.floor(currentwidth / 2));
            currentheight = Math.max(1, Math.floor(currentheight / 2));

            const commandEncoder = this.device.createCommandEncoder();
            const passEncoder = commandEncoder.beginRenderPass({
                colorAttachments: [{
                    view: texture.createView({ baseMipLevel: i, mipLevelCount: 1 }),
                    loadOp: 'clear',
                    storeOp: 'store',
                }],
            });

            passEncoder.setPipeline(pipeline);
            passEncoder.setBindGroup(0, bindGroup);
            passEncoder.draw(6);
            passEncoder.end();

            this.device.queue.submit([commandEncoder.finish()]);
        }
    }

    async loadTexture(url) {
        const response = await fetch(url);
        const blob = await response.blob();
        const img = await createImageBitmap(blob);

        const mipLevelCount = Math.floor(Math.log2(Math.max(img.width, img.height))) + 1;

        const texture = this.device.createTexture({
            size: [img.width, img.height, 1],
            format: 'rgba8unorm',
            mipLevelCount: mipLevelCount,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });

        this.device.queue.copyExternalImageToTexture(
            { source: img },
            { texture: texture },
            [img.width, img.height]
        );

        if (mipLevelCount > 1) {
            this.generateMipmaps(texture);
        }

        return texture;
    }

    createSampler(options = {}) {
        return this.device.createSampler({
            magFilter: options.magFilter || 'linear',
            minFilter: options.minFilter || 'linear',
            addressModeU: options.addressModeU || 'repeat',
            addressModeV: options.addressModeV || 'repeat',
            ...options
        });
    }

    resize(width, height) {
        if (width === this.currentWidth && height === this.currentHeight && (this.sampleCount === 1 || this.msaaTexture)) return;

        this.currentWidth = width;
        this.currentHeight = height;

        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }

        // Recreate MSAA texture if needed
        if (this.sampleCount > 1) {
            if (this.msaaTexture) {
                this.msaaTexture.destroy();
            }
            this.msaaTexture = this.device.createTexture({
                size: [width, height],
                sampleCount: this.sampleCount,
                format: this.format,
                usage: GPUTextureUsage.RENDER_ATTACHMENT,
            });
        } else {
            if (this.msaaTexture) {
                this.msaaTexture.destroy();
                this.msaaTexture = null;
            }
        }
    }

    setMSAA(start) {
        const newSampleCount = start ? 4 : 1;
        if (this.sampleCount !== newSampleCount) {
            this.sampleCount = newSampleCount;
            this.resize(this.currentWidth, this.currentHeight);
        }
    }

    getRenderPassDescriptor(targetTextureView, clearValue = { r: 0.1, g: 0.1, b: 0.1, a: 1.0 }) {
        if (this.sampleCount > 1) {
            return {
                colorAttachments: [{
                    view: this.msaaTexture.createView(),
                    resolveTarget: targetTextureView,
                    clearValue: clearValue,
                    loadOp: 'clear',
                    storeOp: 'discard',
                }]
            };
        } else {
            return {
                colorAttachments: [{
                    view: targetTextureView,
                    clearValue: clearValue,
                    loadOp: 'clear',
                    storeOp: 'store',
                }]
            };
        }
    }

    async createScreenQuadPipeline(shaderCode, bindGroupLayouts = []) {
        const module = this.device.createShaderModule({
            code: shaderCode,
        });

        const compilationInfo = await module.getCompilationInfo();
        if (compilationInfo.messages.length > 0) {
            let hadError = false;
            for (const message of compilationInfo.messages) {
                if (message.type === "error") {
                    hadError = true;
                    console.error(`Shader Error: ${message.message} at line ${message.lineNum}, pos ${message.linePos}`);
                } else {
                    console.warn(`Shader Warning: ${message.message} at line ${message.lineNum}`);
                }
            }
            if (hadError) throw new Error("Shader compilation failed");
        }

        return this.device.createRenderPipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: bindGroupLayouts,
            }),
            vertex: {
                module: module,
                entryPoint: 'vs_main',
            },
            fragment: {
                module: module,
                entryPoint: 'fs_main',
                targets: [{
                    format: this.format,
                }],
            },
            primitive: {
                topology: 'triangle-list',
            },
            multisample: {
                count: this.sampleCount,
            },
        });
    }
}
