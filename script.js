(() => {
  'use strict';

  const CONFIG = {
    gravity: 1850,
    jumpVelocity: -560,
    playerXDesktop: 92,
    playerXMobile: 42,
    obstacleWidthDesktop: 108,
    obstacleWidthMobile: 88,
    obstacleGapDesktop: 220,
    obstacleGapMobile: 195,
    obstacleSpacing: 340,
    baseSpeed: 215,
    speedGain: 3.5,
    groundHeight: 46,
    spawnAhead: 760,
    eggChance: 0.3,
    eggBonus: 3,
    crashLines: 78,
    maxDelta: 0.033,
    birdWidthDesktop: 104,
    birdWidthMobile: 92,
    birdHeightDesktop: 78,
    birdHeightMobile: 68
  };

  const EASTER_EGGS = [
    '404',
    'undefined',
    'NaN',
    'Promise Pending',
    'Syntax Error',
    'Reference Error',
    'git push',
    'npm install',
    'Segmentation Fault'
  ];

  const PARTICLE_TEXT = ['<div>', '</>', '{}', '&&', 'null', 'err', '=>', 'NaN', '/>'];
  const RAIN_TEXT = ['<div>', '</div>', 'const', 'await', '{}', 'npm', 'git', 'NaN', '404', '=>', 'class', 'return'];

  const dom = {
    playfield: document.getElementById('playfield'),
    gameCard: document.getElementById('gameCard'),
    codeBird: document.getElementById('codeBird'),
    obstacleLayer: document.getElementById('obstacleLayer'),
    eggLayer: document.getElementById('eggLayer'),
    particleLayer: document.getElementById('particleLayer'),
    crashLayer: document.getElementById('crashLayer'),
    startOverlay: document.getElementById('startOverlay'),
    gameOverOverlay: document.getElementById('gameOverOverlay'),
    startButton: document.getElementById('startButton'),
    restartButton: document.getElementById('restartButton'),
    scoreValue: document.getElementById('scoreValue'),
    bestValue: document.getElementById('bestValue'),
    fpsValue: document.getElementById('fpsValue'),
    screenFlash: document.getElementById('screenFlash'),
    codeRain: document.getElementById('codeRain')
  };

  const storage = {
    getBest() {
      try {
        return Number(localStorage.getItem('missingDivBest')) || 0;
      } catch (error) {
        return 0;
      }
    },
    setBest(value) {
      try {
        localStorage.setItem('missingDivBest', String(value));
      } catch (error) {
        // Local files in strict browser modes may block storage; gameplay still works.
      }
    }
  };

  const random = (min, max) => Math.random() * (max - min) + min;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  class AudioEngine {
    constructor() {
      this.context = null;
      this.master = null;
    }

    ensureContext() {
      if (this.context) {
        if (this.context.state === 'suspended') {
          this.context.resume();
        }
        return;
      }

      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;

      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = 0.08;
      this.master.connect(this.context.destination);
    }

    beep(frequency, duration, type = 'square', volume = 0.14, slideTo = null) {
      this.ensureContext();
      if (!this.context || !this.master) return;

      const now = this.context.currentTime;
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();

      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, now);
      if (slideTo) {
        oscillator.frequency.exponentialRampToValueAtTime(slideTo, now + duration);
      }

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(volume, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

      oscillator.connect(gain);
      gain.connect(this.master);
      oscillator.start(now);
      oscillator.stop(now + duration + 0.02);
    }

    playJump() {
      this.beep(330, 0.09, 'square', 0.12, 540);
    }

    playScore() {
      this.beep(880, 0.08, 'triangle', 0.12, 1320);
    }

    playDeath() {
      this.beep(220, 0.28, 'sawtooth', 0.18, 55);
      setTimeout(() => this.beep(92, 0.18, 'square', 0.1, 46), 80);
    }
  }

  class Game {
    constructor() {
      this.audio = new AudioEngine();
      this.best = storage.getBest();
      this.metrics = this.measure();
      this.state = this.createInitialState();
      this.lastFrame = 0;
      this.fpsAccumulator = 0;
      this.fpsFrames = 0;
      this.crashAccumulator = 0;
      this.crashSpawned = 0;
      this.rafId = null;

      this.bindEvents();
      this.createCodeRain();
      this.updateHud();
      this.resetWorld();
      this.loop = this.loop.bind(this);
      this.rafId = requestAnimationFrame(this.loop);
    }

    createInitialState() {
      return {
        phase: 'ready',
        score: 0,
        player: {
          x: this.metrics.playerX,
          y: this.metrics.height * 0.42,
          velocity: 0,
          rotation: 0,
          width: this.metrics.birdWidth,
          height: this.metrics.birdHeight
        },
        obstacles: [],
        eggs: [],
        nextObstacleX: this.metrics.width + 80
      };
    }

    measure() {
      const rect = dom.playfield.getBoundingClientRect();
      const isMobile = rect.width < 640;
      const width = rect.width || 760;
      const height = rect.height || 540;

      return {
        width,
        height,
        isMobile,
        playerX: isMobile ? CONFIG.playerXMobile : CONFIG.playerXDesktop,
        obstacleWidth: isMobile ? CONFIG.obstacleWidthMobile : CONFIG.obstacleWidthDesktop,
        gap: isMobile ? CONFIG.obstacleGapMobile : CONFIG.obstacleGapDesktop,
        birdWidth: isMobile ? CONFIG.birdWidthMobile : CONFIG.birdWidthDesktop,
        birdHeight: isMobile ? CONFIG.birdHeightMobile : CONFIG.birdHeightDesktop,
        ceiling: 0,
        floor: height - CONFIG.groundHeight
      };
    }

    bindEvents() {
      dom.startButton.addEventListener('click', event => {
        event.stopPropagation();
        this.start();
      });

      dom.restartButton.addEventListener('click', event => {
        event.stopPropagation();
        this.restart();
      });

      dom.playfield.addEventListener('pointerdown', event => {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        this.handleAction();
      });

      window.addEventListener('keydown', event => {
        if (event.code !== 'Space') return;
        event.preventDefault();
        this.handleAction();
      });

      window.addEventListener('resize', () => this.handleResize(), { passive: true });
      window.addEventListener('blur', () => {
        this.lastFrame = 0;
      });
    }

    handleAction() {
      if (this.state.phase === 'ready') {
        this.start();
        return;
      }

      if (this.state.phase === 'dead') return;
      this.jump();
    }

    handleResize() {
      const previousHeight = this.metrics.height;
      this.metrics = this.measure();
      this.state.player.x = this.metrics.playerX;
      this.state.player.width = this.metrics.birdWidth;
      this.state.player.height = this.metrics.birdHeight;

      const ratio = previousHeight ? this.metrics.height / previousHeight : 1;
      this.state.player.y = clamp(this.state.player.y * ratio, 16, this.metrics.floor - this.state.player.height - 2);
    }

    start() {
      this.audio.ensureContext();
      if (this.state.phase === 'running') return;
      dom.startOverlay.classList.remove('is-visible');
      dom.playfield.focus({ preventScroll: true });
      this.state.phase = 'running';
      this.jump();
    }

    restart() {
      this.audio.ensureContext();
      this.metrics = this.measure();
      this.state = this.createInitialState();
      this.crashAccumulator = 0;
      this.crashSpawned = 0;
      this.resetWorld();
      dom.gameOverOverlay.classList.remove('is-visible');
      dom.startOverlay.classList.remove('is-visible');
      dom.playfield.classList.remove('is-shaking');
      dom.playfield.focus({ preventScroll: true });
      this.state.phase = 'running';
      this.jump();
      this.updateHud();
    }

    resetWorld() {
      dom.obstacleLayer.textContent = '';
      dom.eggLayer.textContent = '';
      dom.particleLayer.textContent = '';
      dom.crashLayer.textContent = '';
      this.state.obstacles = [];
      this.state.eggs = [];
      this.state.nextObstacleX = this.metrics.width + 80;
      this.renderPlayer();
    }

    jump() {
      this.state.player.velocity = CONFIG.jumpVelocity;
      this.audio.playJump();
      this.spawnParticles(this.state.player.x + 18, this.state.player.y + this.state.player.height * 0.52, 5, '#4fc1ff');
    }

    loop(timestamp) {
      if (!this.lastFrame) this.lastFrame = timestamp;
      const dt = Math.min((timestamp - this.lastFrame) / 1000, CONFIG.maxDelta);
      this.lastFrame = timestamp;

      this.updateFps(dt);
      if (this.state.phase === 'running') {
        this.update(dt);
      } else if (this.state.phase === 'dead') {
        this.updateCrash(dt);
      }
      this.render();
      this.rafId = requestAnimationFrame(this.loop);
    }

    update(dt) {
      const speed = CONFIG.baseSpeed + this.state.score * CONFIG.speedGain;
      this.updatePlayer(dt);
      this.spawnObstaclesIfNeeded();
      this.updateObstacles(dt, speed);
      this.updateEggs(dt, speed);
      this.checkCollisions();
    }

    updatePlayer(dt) {
      const player = this.state.player;
      player.velocity += CONFIG.gravity * dt;
      player.y += player.velocity * dt;
      player.rotation = clamp(player.velocity / 16, -24, 72);
    }

    spawnObstaclesIfNeeded() {
      let furthestX = this.state.obstacles.reduce((maxX, obstacle) => Math.max(maxX, obstacle.x), -Infinity);

      while (furthestX < this.metrics.width + CONFIG.spawnAhead) {
        const nextX = Number.isFinite(furthestX)
          ? furthestX + CONFIG.obstacleSpacing
          : this.metrics.width + 80;
        this.createObstacle(nextX);
        furthestX = nextX;
      }
    }

    createObstacle(x) {
      const minTop = 68;
      const maxTop = this.metrics.floor - this.metrics.gap - 92;
      const topHeight = Math.max(minTop, random(minTop, Math.max(minTop + 1, maxTop)));
      const bottomY = topHeight + this.metrics.gap;
      const bottomHeight = this.metrics.floor - bottomY;
      const element = document.createElement('div');
      element.className = 'obstacle';
      element.style.height = `${this.metrics.floor}px`;
      element.innerHTML = `
        <div class="pipe-segment pipe-top" style="height:${topHeight}px">
          <span class="pipe-lip"></span>
          <span class="pipe-label">&lt;div&gt;</span>
        </div>
        <div class="pipe-segment pipe-bottom" style="height:${bottomHeight}px; top:${bottomY}px">
          <span class="pipe-lip"></span>
          <span class="pipe-label">&lt;div&gt;</span>
        </div>
      `;
      dom.obstacleLayer.appendChild(element);

      const obstacle = {
        x,
        width: this.metrics.obstacleWidth,
        topHeight,
        bottomY,
        bottomHeight,
        scored: false,
        element
      };
      this.state.obstacles.push(obstacle);

      if (Math.random() < CONFIG.eggChance) {
        this.createEgg(x + CONFIG.obstacleSpacing * 0.5, topHeight + this.metrics.gap * 0.5);
      }
    }

    createEgg(x, y) {
      const label = EASTER_EGGS[Math.floor(Math.random() * EASTER_EGGS.length)];
      const element = document.createElement('div');
      element.className = 'egg';
      element.textContent = label;
      dom.eggLayer.appendChild(element);

      this.state.eggs.push({
        x,
        y: clamp(y + random(-28, 28), 74, this.metrics.floor - 88),
        width: Math.max(58, label.length * 8 + 34),
        height: 30,
        label,
        element
      });
    }

    updateObstacles(dt, speed) {
      const player = this.state.player;
      for (const obstacle of this.state.obstacles) {
        obstacle.x -= speed * dt;
        if (!obstacle.scored && obstacle.x + obstacle.width < player.x) {
          obstacle.scored = true;
          this.addScore(1, obstacle.x + obstacle.width, obstacle.topHeight + this.metrics.gap * 0.5);
        }
      }

      this.state.obstacles = this.state.obstacles.filter(obstacle => {
        const keep = obstacle.x + obstacle.width > -40;
        if (!keep) {
          obstacle.element.remove();
        }
        return keep;
      });
    }

    updateEggs(dt, speed) {
      const playerRect = this.getPlayerRect();

      for (const egg of this.state.eggs) {
        egg.x -= speed * dt;
        egg.y += Math.sin((egg.x + performance.now() * 0.12) * 0.035) * 0.35;

        if (this.rectsOverlap(playerRect, {
          left: egg.x,
          right: egg.x + egg.width,
          top: egg.y,
          bottom: egg.y + egg.height
        })) {
          egg.collected = true;
          this.addScore(CONFIG.eggBonus, egg.x, egg.y, true);
          this.spawnParticles(egg.x, egg.y, 12, '#ffd866');
        }
      }

      this.state.eggs = this.state.eggs.filter(egg => {
        const keep = !egg.collected && egg.x + egg.width > -50;
        if (!keep) egg.element.remove();
        return keep;
      });
    }

    addScore(amount, x, y, isBonus = false) {
      this.state.score += amount;
      if (this.state.score > this.best) {
        this.best = this.state.score;
        storage.setBest(this.best);
      }
      this.audio.playScore();
      this.spawnParticles(x, y, isBonus ? 10 : 6, isBonus ? '#ffd866' : '#31ff85');
      this.updateHud();
    }

    checkCollisions() {
      const player = this.state.player;
      const playerRect = this.getPlayerRect();

      if (player.y <= this.metrics.ceiling || player.y + player.height >= this.metrics.floor) {
        this.gameOver();
        return;
      }

      for (const obstacle of this.state.obstacles) {
        const topRect = {
          left: obstacle.x,
          right: obstacle.x + obstacle.width,
          top: 0,
          bottom: obstacle.topHeight
        };
        const bottomRect = {
          left: obstacle.x,
          right: obstacle.x + obstacle.width,
          top: obstacle.bottomY,
          bottom: this.metrics.floor
        };

        if (this.rectsOverlap(playerRect, topRect) || this.rectsOverlap(playerRect, bottomRect)) {
          this.gameOver();
          return;
        }
      }
    }

    getPlayerRect() {
      const player = this.state.player;
      const insetX = player.width * 0.12;
      const insetY = player.height * 0.12;
      return {
        left: player.x + insetX,
        right: player.x + player.width - insetX,
        top: player.y + insetY,
        bottom: player.y + player.height - insetY
      };
    }

    rectsOverlap(a, b) {
      return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    }

    gameOver() {
      if (this.state.phase !== 'running') return;
      this.state.phase = 'dead';
      this.audio.playDeath();
      dom.gameOverOverlay.classList.add('is-visible');
      this.flashScreen();
      this.shakeScreen();
      this.spawnParticles(this.state.player.x + this.state.player.width * 0.5, this.state.player.y + this.state.player.height * 0.5, 26, '#ff4d5e');
      this.updateHud();
    }

    updateCrash(dt) {
      if (this.crashSpawned >= CONFIG.crashLines) return;
      this.crashAccumulator += dt;
      const targetDelay = Math.max(0.008, 0.055 - this.crashSpawned * 0.00065);

      while (this.crashAccumulator >= targetDelay && this.crashSpawned < CONFIG.crashLines) {
        this.crashAccumulator -= targetDelay;
        this.spawnCrashLine();
      }
    }

    spawnCrashLine() {
      const line = document.createElement('span');
      line.className = 'crash-div';
      line.textContent = '<div>';
      line.style.setProperty('--indent', `${Math.floor(random(0, Math.min(260, this.metrics.width * 0.42)))}px`);
      dom.crashLayer.appendChild(line);
      this.crashSpawned += 1;
    }

    flashScreen() {
      dom.screenFlash.classList.remove('is-active');
      void dom.screenFlash.offsetWidth;
      dom.screenFlash.classList.add('is-active');
    }

    shakeScreen() {
      dom.playfield.classList.remove('is-shaking');
      void dom.playfield.offsetWidth;
      dom.playfield.classList.add('is-shaking');
    }

    spawnParticles(x, y, count, color) {
      for (let index = 0; index < count; index += 1) {
        const particle = document.createElement('span');
        particle.className = 'particle';
        particle.textContent = PARTICLE_TEXT[Math.floor(Math.random() * PARTICLE_TEXT.length)];
        particle.style.left = `${x}px`;
        particle.style.top = `${y}px`;
        particle.style.color = color;
        particle.style.setProperty('--dx', `${random(-110, 110)}px`);
        particle.style.setProperty('--dy', `${random(-100, 80)}px`);
        particle.style.setProperty('--rot', `${random(-220, 220)}deg`);
        dom.particleLayer.appendChild(particle);
        particle.addEventListener('animationend', () => particle.remove(), { once: true });
      }
    }

    render() {
      this.renderPlayer();
      for (const obstacle of this.state.obstacles) {
        obstacle.element.style.transform = `translate3d(${obstacle.x}px, 0, 0)`;
      }
      for (const egg of this.state.eggs) {
        egg.element.style.transform = `translate3d(${egg.x}px, ${egg.y}px, 0)`;
      }
    }

    renderPlayer() {
      const player = this.state.player;
      dom.codeBird.style.transform = `translate3d(${player.x}px, ${player.y}px, 0) rotate(${player.rotation}deg)`;
      dom.playfield.style.setProperty('--bloom-x', `${player.x + player.width * 0.5}px`);
      dom.playfield.style.setProperty('--bloom-y', `${player.y + player.height * 0.5}px`);
    }

    updateHud() {
      dom.scoreValue.textContent = String(this.state.score);
      dom.bestValue.textContent = String(this.best);
    }

    updateFps(dt) {
      if (!dt) return;
      this.fpsAccumulator += dt;
      this.fpsFrames += 1;
      if (this.fpsAccumulator >= 0.35) {
        const fps = Math.round(this.fpsFrames / this.fpsAccumulator);
        dom.fpsValue.textContent = String(clamp(fps, 0, 144));
        this.fpsAccumulator = 0;
        this.fpsFrames = 0;
      }
    }

    createCodeRain() {
      const tokenCount = Math.min(72, Math.max(34, Math.floor(window.innerWidth / 18)));
      const fragment = document.createDocumentFragment();

      for (let index = 0; index < tokenCount; index += 1) {
        const token = document.createElement('span');
        token.className = 'rain-token';
        token.textContent = RAIN_TEXT[Math.floor(Math.random() * RAIN_TEXT.length)];
        token.style.left = `${random(0, 100)}vw`;
        token.style.animationDuration = `${random(6, 16)}s`;
        token.style.animationDelay = `${random(-16, 0)}s`;
        token.style.opacity = String(random(0.22, 0.75));
        fragment.appendChild(token);
      }

      dom.codeRain.appendChild(fragment);
    }
  }

  new Game();
})();
