// Exact port of "Chromatic Aberration WebGL Sine Wave" by Yuki
// (https://codepen.io/yukiloz7/pen/yLgYpWM), unmodified apart from
// running against #webgl-canvas already present in this page.

class Stage {
  constructor() {
    this.renderParam = {
      clearColor: 0x666666,
      width: window.innerWidth,
      height: window.innerHeight
    };

    this.cameraParam = {
      left: -1,
      right: 1,
      top: 1,
      bottom: 1,
      near: 0,
      far: -1
    };

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.geometry = null;
    this.material = null;
    this.mesh = null;

    this.isInitialized = false;
  }

  init() {
    this._setScene();
    this._setRender();
    this._setCamera();

    this.isInitialized = true;
  }

  _setScene() {
    this.scene = new THREE.Scene();
  }

  _setRender() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: document.getElementById("webgl-canvas")
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(new THREE.Color(this.renderParam.clearColor));
    this.renderer.setSize(this.renderParam.width, this.renderParam.height);
  }

  _setCamera() {
    if (!this.isInitialized) {
      this.camera = new THREE.OrthographicCamera(
        this.cameraParam.left,
        this.cameraParam.right,
        this.cameraParam.top,
        this.cameraParam.bottom,
        this.cameraParam.near,
        this.cameraParam.far
      );
    }

    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;

    this.camera.aspect = windowWidth / windowHeight;

    this.camera.updateProjectionMatrix();
    this.renderer.setSize(windowWidth, windowHeight);
  }

  _render() {
    this.renderer.render(this.scene, this.camera);
  }

  onResize() {
    this._setCamera();
  }

  onRaf() {
    this._render();
  }
}

class Mesh {
  constructor(stage) {
    this.canvas = document.getElementById("webgl-canvas");
    this.canvasWidth = this.canvas.width;
    this.canvasHeight = this.canvas.height;

    this.uniforms = {
      resolution: { type: "v2", value: [ this.canvasWidth, this.canvasHeight ] },
      time: { type: "f", value: 0.0 },
      xScale: { type: "f", value: 1.0 },
      yScale: { type: "f", value: 0.5 },
      distortion: { type: "f", value: 0.050 }
    };

    this.stage = stage;

    this.mesh = null;

    this.xScale = 1.0;
    this.yScale = 0.5;
    this.distortion = 0.050;
  }

  init() {
    this._setMesh();
  }

  _setMesh() {
    const position = [
      -1.0, -1.0, 0.0,
       1.0, -1.0, 0.0,
      -1.0,  1.0, 0.0,
       1.0, -1.0, 0.0,
      -1.0,  1.0, 0.0,
       1.0,  1.0, 0.0
    ];

    const positions = new THREE.BufferAttribute(new Float32Array(position), 3);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", positions);

    const material = new THREE.RawShaderMaterial({
      vertexShader: document.getElementById("js-vertex-shader").textContent,
      fragmentShader: document.getElementById("js-fragment-shader").textContent,
      uniforms: this.uniforms,
      side: THREE.DoubleSide
    });

    this.mesh = new THREE.Mesh(geometry, material);

    this.stage.scene.add(this.mesh);
  }

  _render(delta) {
    // Advance by real elapsed time (not a fixed per-frame step) so the
    // wave moves at the same speed on every display, no matter its
    // refresh rate — this is what keeps the loop feeling seamless
    // instead of speeding up/slowing down on different monitors.
    this.uniforms.time.value += delta * 0.6;
  }

  onRaf(delta) {
    this._render(delta);
  }
}

(() => {
  const stage = new Stage();

  stage.init();

  const mesh = new Mesh(stage);

  mesh.init();

  window.addEventListener("resize", () => {
    stage.onResize();
  });

  const clock = new THREE.Clock();

  const _raf = () => {
    window.requestAnimationFrame(() => {
      // Cap the delta so returning to the tab after it was backgrounded
      // (or a stutter) doesn't jump the wave forward all at once.
      const delta = Math.min(clock.getDelta(), 1 / 30);

      stage.onRaf();
      mesh.onRaf(delta);

      _raf();
    });
  };

  _raf();
})();
