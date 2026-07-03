/**
 * 3D Warehouse Space Configuration Display
 * 
 * Features:
 * - 4-layer storage racks with 2 sides per level, 3 boxes per side
 * - Box numbering system
 * - Search functionality with navigation arrows
 * - R1 right side as entrance
 * - Interactive camera controls
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Configuration - Layout: 10 racks per row, 2 sides per level, 4 levels
const CONFIG = {
    rack: {
        rows: 4,              // Number of rack rows (Z direction)
        sidesPerLevel: 2,     // Left side (A) and Right side (B)
        boxesPerSide: 10,     // 10 boxes per side (10 racks per row)
        levels: 4,            // Number of vertical levels
        slotWidth: 2.2,       // Width of each box slot
        slotHeight: 2,        // Height of each level
        rackDepth: 6,         // Total depth of rack (both sides)
        frameThickness: 0.12,
        aisleWidth: 5,        // Width between rack rows (walking aisle)
        centerGap: 0.3,       // Gap between the two sides
    },
    box: {
        width: 1.8,
        height: 1.2,
        depth: 2.0,
    },
    colors: {
        occupied: 0x3b82f6,     // Blue
        available: 0x22c55e,    // Green
        reserved: 0xf59e0b,     // Orange/Yellow
        highlight: 0xff3366,    // Highlight pink/red
        frame: 0x475569,        // Slate gray
        floor: 0x1e293b,        // Dark slate
        arrow: 0x22c55e,        // Green arrow
    },
    entrance: {
        row: 0,              // R1
        side: 'B',           // Right side (B)
        distanceFromRack: 55, // Distance from R1 (about 5 rack widths = 5 * 11 = 55)
    }
};

// Global state
let warehouseData = [];
let scene, camera, renderer, controls;
let raycaster, mouse;
let boxes = [];
let boxLabels = [];
let labels = [];
let gridHelper;
let navigationArrows = [];
let highlightedBox = null;
let workerMarker = null;      // Draggable worker/person marker
let workerLabel = null;       // Worker label sprite
let isDraggingWorker = false; // Drag state
let dragPlane = null;         // Plane for raycasting during drag
let floorMesh = null;         // Reference to floor for raycasting
let floorPallets = [];        // Floor pallets storage

// DOM Elements
const loadingScreen = document.getElementById('loading-screen');
const progressFill = document.getElementById('progress-fill');
const infoPanel = document.getElementById('info-panel');
const closeInfoBtn = document.getElementById('close-info');
const toggleLabels = document.getElementById('toggle-labels');
const toggleBoxes = document.getElementById('toggle-boxes');
const toggleGrid = document.getElementById('toggle-grid');
const viewButtons = {
    front: document.getElementById('view-front'),
    top: document.getElementById('view-top'),
    side: document.getElementById('view-side'),
    iso: document.getElementById('view-iso'),
};

/**
 * Generate box ID based on position
 * Format: R{row}-{side}{position}-L{level}
 * Example: R1-A1-L1, R1-B3-L4
 */
function generateBoxId(row, side, position, level) {
    const sideLetter = side === 0 ? 'A' : 'B';
    return `R${row + 1}-${sideLetter}${position + 1}-L${level + 1}`;
}

/**
 * Generate mock warehouse inventory data
 */
function generateWarehouseData() {
    const data = [];
    const statuses = ['occupied', 'available', 'reserved'];
    const itemNames = ['電子零件 A', '布料 B-01', '原料包 C', '成品箱 D', '包材 E', '零件 F'];

    let occupiedCount = 0;
    const totalSlots = CONFIG.rack.rows * CONFIG.rack.sidesPerLevel * CONFIG.rack.boxesPerSide * CONFIG.rack.levels;

    for (let row = 0; row < CONFIG.rack.rows; row++) {
        for (let side = 0; side < CONFIG.rack.sidesPerLevel; side++) {
            for (let pos = 0; pos < CONFIG.rack.boxesPerSide; pos++) {
                for (let level = 0; level < CONFIG.rack.levels; level++) {
                    // Weighted random: more occupied than available/reserved
                    const rand = Math.random();
                    let status;
                    if (rand < 0.70) {
                        status = 'occupied';
                        occupiedCount++;
                    } else if (rand < 0.88) {
                        status = 'available';
                    } else {
                        status = 'reserved';
                        occupiedCount++;
                    }

                    const boxId = generateBoxId(row, side, pos, level);
                    const hasBox = status !== 'available';

                    data.push({
                        row,
                        side,         // 0 = A (left), 1 = B (right)
                        position: pos,
                        level,
                        boxId,
                        status,
                        hasBox,
                        item: hasBox ? itemNames[Math.floor(Math.random() * itemNames.length)] : '',
                    });
                }
            }
        }
    }

    // Update stats display
    setTimeout(() => {
        document.getElementById('total-slots').textContent = totalSlots;
        document.getElementById('occupied-slots').textContent = occupiedCount;
        document.getElementById('usage-rate').textContent = Math.round(occupiedCount / totalSlots * 100) + '%';
    }, 100);

    return data;
}

/**
 * Initialize the 3D scene
 */
function init() {
    updateProgress(10);

    // Generate warehouse data
    warehouseData = generateWarehouseData();

    // Create scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);
    // Removed fog temporarily to debug visibility
    // scene.fog = new THREE.Fog(0x0f172a, 100, 300);

    // Create camera - positioned to see larger warehouse
    camera = new THREE.PerspectiveCamera(
        60,
        window.innerWidth / window.innerHeight,
        0.1,
        1000
    );
    camera.position.set(40, 35, 50);

    updateProgress(20);

    // Create renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.getElementById('canvas-container').appendChild(renderer.domElement);

    // Create controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.maxDistance = 200;
    controls.minDistance = 15;
    controls.maxPolarAngle = Math.PI / 2 - 0.05;
    controls.target.set(0, 4, 0);  // Look at warehouse center

    updateProgress(30);

    // Raycaster for mouse interaction
    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();

    // Add lights
    addLights();
    updateProgress(40);

    // Add floor
    addFloor();
    updateProgress(50);

    // Create storage racks
    createRacks();
    updateProgress(65);

    // Create boxes
    createBoxes();
    updateProgress(80);

    // Add labels
    createLabels();
    updateProgress(90);

    // Create draggable worker marker
    createWorkerMarker();

    // Create floor pallets near R1
    createFloorPallets();
    updateProgress(100);

    // Setup event listeners
    setupEventListeners();

    // Hide loading screen
    setTimeout(() => {
        loadingScreen.classList.add('hidden');
    }, 500);

    // Start animation loop
    animate();
}

/**
 * Update loading progress
 */
function updateProgress(percent) {
    progressFill.style.width = percent + '%';
}

/**
 * Add lights to the scene
 */
function addLights() {
    // Ambient light
    const ambientLight = new THREE.AmbientLight(0x404050, 0.7);
    scene.add(ambientLight);

    // Main directional light
    const mainLight = new THREE.DirectionalLight(0xffffff, 1.2);
    mainLight.position.set(25, 50, 25);
    mainLight.castShadow = true;
    mainLight.shadow.mapSize.width = 2048;
    mainLight.shadow.mapSize.height = 2048;
    mainLight.shadow.camera.near = 1;
    mainLight.shadow.camera.far = 120;
    mainLight.shadow.camera.left = -50;
    mainLight.shadow.camera.right = 50;
    mainLight.shadow.camera.top = 50;
    mainLight.shadow.camera.bottom = -50;
    scene.add(mainLight);

    // Fill light
    const fillLight = new THREE.DirectionalLight(0x8888ff, 0.4);
    fillLight.position.set(-15, 25, -15);
    scene.add(fillLight);

    // Industrial warehouse point lights
    const colors = [0x3b82f6, 0x60a5fa, 0x2563eb, 0x3b82f6];
    for (let i = 0; i < 4; i++) {
        const pointLight = new THREE.PointLight(colors[i], 0.4, 35);
        pointLight.position.set((i - 1.5) * 12, 14, 0);
        scene.add(pointLight);
    }
}

/**
 * Add floor with grid - larger to accommodate entrance area
 */
function addFloor() {
    // Floor plane - extended for distant entrance
    const floorGeometry = new THREE.PlaneGeometry(200, 200);
    const floorMaterial = new THREE.MeshStandardMaterial({
        color: CONFIG.colors.floor,
        roughness: 0.8,
        metalness: 0.2,
    });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Grid helper - larger grid
    gridHelper = new THREE.GridHelper(200, 100, 0x3b82f6, 0x1e3a5f);
    gridHelper.position.y = 0.01;
    scene.add(gridHelper);
}

/**
 * Calculate the world position for a given rack position
 */
function getRackWorldZ(row) {
    const { rows, rackDepth, aisleWidth } = CONFIG.rack;
    return row * (rackDepth + aisleWidth) - ((rows - 1) * (rackDepth + aisleWidth)) / 2;
}

/**
 * Create storage rack structures - 2 sides per level, 3 boxes per side
 */
function createRacks() {
    const { rows, boxesPerSide, levels, slotWidth, slotHeight, rackDepth, frameThickness, centerGap } = CONFIG.rack;

    const frameMaterial = new THREE.MeshStandardMaterial({
        color: CONFIG.colors.frame,
        roughness: 0.5,
        metalness: 0.7,
    });

    const rackWidth = boxesPerSide * slotWidth;
    const rackHeight = levels * slotHeight;
    const halfDepth = (rackDepth - centerGap) / 2;

    for (let row = 0; row < rows; row++) {
        const rowZ = getRackWorldZ(row);

        // Create vertical posts (uprights) at corners
        for (let c = 0; c <= boxesPerSide; c++) {
            const postX = c * slotWidth - rackWidth / 2;

            // Front posts (Side A)
            const postGeometryA = new THREE.BoxGeometry(frameThickness, rackHeight, frameThickness);
            const postA = new THREE.Mesh(postGeometryA, frameMaterial);
            postA.position.set(postX, rackHeight / 2, rowZ - halfDepth / 2 - centerGap / 2);
            postA.castShadow = true;
            scene.add(postA);

            // Back posts (Side B)
            const postB = new THREE.Mesh(postGeometryA, frameMaterial);
            postB.position.set(postX, rackHeight / 2, rowZ + halfDepth / 2 + centerGap / 2);
            postB.castShadow = true;
            scene.add(postB);
        }

        // Create horizontal beams and shelves for each level
        for (let level = 0; level <= levels; level++) {
            const beamY = level * slotHeight;

            // Side A beams (front and back of side A)
            for (let fb = -1; fb <= 1; fb += 2) {
                const beamGeometry = new THREE.BoxGeometry(rackWidth, frameThickness, frameThickness);
                const beam = new THREE.Mesh(beamGeometry, frameMaterial);
                const zOffset = rowZ - halfDepth / 2 - centerGap / 2 + fb * (halfDepth / 2 - frameThickness / 2);
                beam.position.set(0, beamY, zOffset);
                beam.castShadow = true;
                scene.add(beam);
            }

            // Side B beams (front and back of side B)
            for (let fb = -1; fb <= 1; fb += 2) {
                const beamGeometry = new THREE.BoxGeometry(rackWidth, frameThickness, frameThickness);
                const beam = new THREE.Mesh(beamGeometry, frameMaterial);
                const zOffset = rowZ + halfDepth / 2 + centerGap / 2 + fb * (halfDepth / 2 - frameThickness / 2);
                beam.position.set(0, beamY, zOffset);
                beam.castShadow = true;
                scene.add(beam);
            }

            // Cross beams connecting posts
            for (let c = 0; c <= boxesPerSide; c++) {
                const crossX = c * slotWidth - rackWidth / 2;

                // Side A cross beams
                const crossGeomA = new THREE.BoxGeometry(frameThickness, frameThickness, halfDepth);
                const crossA = new THREE.Mesh(crossGeomA, frameMaterial);
                crossA.position.set(crossX, beamY, rowZ - halfDepth / 2 - centerGap / 2);
                crossA.castShadow = true;
                scene.add(crossA);

                // Side B cross beams
                const crossB = new THREE.Mesh(crossGeomA, frameMaterial);
                crossB.position.set(crossX, beamY, rowZ + halfDepth / 2 + centerGap / 2);
                crossB.castShadow = true;
                scene.add(crossB);
            }

            // Add shelf surfaces
            if (level < levels) {
                const shelfGeometry = new THREE.BoxGeometry(rackWidth - frameThickness, frameThickness / 2, halfDepth - frameThickness);
                const shelfMaterial = new THREE.MeshStandardMaterial({
                    color: 0x334155,
                    roughness: 0.6,
                    metalness: 0.3,
                });

                // Side A shelf
                const shelfA = new THREE.Mesh(shelfGeometry, shelfMaterial);
                shelfA.position.set(0, level * slotHeight + frameThickness / 2, rowZ - halfDepth / 2 - centerGap / 2);
                shelfA.receiveShadow = true;
                scene.add(shelfA);

                // Side B shelf
                const shelfB = new THREE.Mesh(shelfGeometry, shelfMaterial);
                shelfB.position.set(0, level * slotHeight + frameThickness / 2, rowZ + halfDepth / 2 + centerGap / 2);
                shelfB.receiveShadow = true;
                scene.add(shelfB);
            }
        }
    }
}

/**
 * Calculate box position in world coordinates
 */
function getBoxWorldPosition(slot) {
    const { boxesPerSide, slotWidth, slotHeight, rackDepth, centerGap, frameThickness } = CONFIG.rack;
    const { height } = CONFIG.box;

    const rackWidth = boxesPerSide * slotWidth;
    const halfDepth = (rackDepth - centerGap) / 2;

    const x = (slot.position - (boxesPerSide - 1) / 2) * slotWidth;
    const y = slot.level * slotHeight + height / 2 + frameThickness;

    // Side A (0) is at negative Z, Side B (1) is at positive Z
    const rowZ = getRackWorldZ(slot.row);
    const sideOffset = slot.side === 0
        ? rowZ - halfDepth / 2 - centerGap / 2
        : rowZ + halfDepth / 2 + centerGap / 2;

    return new THREE.Vector3(x, y, sideOffset);
}

/**
 * Create boxes based on warehouse data with labels
 * Shows ALL storage slots including empty ones
 */
function createBoxes() {
    const { width, height, depth } = CONFIG.box;

    warehouseData.forEach((slot) => {
        const pos = getBoxWorldPosition(slot);

        // Create box geometry
        const boxGeometry = new THREE.BoxGeometry(width, height, depth);

        // Different visual for empty vs occupied slots
        let boxMaterial;
        let color;

        if (!slot.hasBox) {
            // Empty slot - show as transparent wireframe placeholder
            color = 0x1e3a5f;  // Dark blue for empty
            boxMaterial = new THREE.MeshStandardMaterial({
                color: color,
                roughness: 0.8,
                metalness: 0.1,
                transparent: true,
                opacity: 0.15,  // Very transparent for empty slots
            });
        } else {
            // Occupied/reserved slot - solid color
            color = CONFIG.colors[slot.status];
            boxMaterial = new THREE.MeshStandardMaterial({
                color: color,
                roughness: 0.4,
                metalness: 0.1,
            });
        }

        const box = new THREE.Mesh(boxGeometry, boxMaterial);
        box.position.copy(pos);
        box.castShadow = slot.hasBox;  // Only occupied cast shadows
        box.receiveShadow = true;

        // Store data reference and original color
        box.userData = slot;
        box.userData.originalColor = color;

        boxes.push(box);
        scene.add(box);

        // Add edges for better visibility
        const edgesGeometry = new THREE.EdgesGeometry(boxGeometry);
        const edgesMaterial = new THREE.LineBasicMaterial({
            color: slot.hasBox ? 0xffffff : 0x3b82f6,  // Blue edges for empty slots
            opacity: slot.hasBox ? 0.3 : 0.6,
            transparent: true
        });
        const edges = new THREE.LineSegments(edgesGeometry, edgesMaterial);
        box.add(edges);

        // Add box label sprite (only for occupied slots to reduce clutter)
        if (slot.hasBox) {
            createBoxLabel(box, slot.boxId);
        }
    });
}

/**
 * Create a label sprite for a box
 */
function createBoxLabel(box, text) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 48;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.roundRect(0, 0, 128, 48, 6);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 64, 24);

    const texture = new THREE.CanvasTexture(canvas);
    const labelMaterial = new THREE.SpriteMaterial({ map: texture });
    const label = new THREE.Sprite(labelMaterial);

    label.position.set(0, CONFIG.box.height / 2 + 0.5, 0);
    label.scale.set(1.5, 0.6, 1);

    box.add(label);
    boxLabels.push(label);
}

/**
 * Create rack row labels and side indicators
 */
function createLabels() {
    const { rows, boxesPerSide, slotWidth, rackDepth, aisleWidth, centerGap } = CONFIG.rack;
    const rackWidth = boxesPerSide * slotWidth;
    const halfDepth = (rackDepth - centerGap) / 2;

    for (let row = 0; row < rows; row++) {
        const rowZ = getRackWorldZ(row);

        // Rack row label
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 80;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        ctx.roundRect(0, 0, 256, 80, 12);
        ctx.fill();

        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2;
        ctx.roundRect(2, 2, 252, 76, 10);
        ctx.stroke();

        ctx.fillStyle = '#f8fafc';
        ctx.font = 'bold 36px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`儲架 R${row + 1}`, 128, 40);

        const texture = new THREE.CanvasTexture(canvas);
        const labelMaterial = new THREE.SpriteMaterial({ map: texture });
        const label = new THREE.Sprite(labelMaterial);

        label.position.set(rackWidth / 2 + 3, 9, rowZ);
        label.scale.set(5, 1.6, 1);

        labels.push(label);
        scene.add(label);

        // Side A label (left/front)
        const sideALabel = createSideLabel('A側', rowZ - halfDepth - centerGap / 2 - 1.5);
        sideALabel.position.x = -rackWidth / 2 - 2;
        sideALabel.position.y = 5;
        labels.push(sideALabel);
        scene.add(sideALabel);

        // Side B label (right/back)
        const sideBLabel = createSideLabel('B側', rowZ + halfDepth + centerGap / 2 + 1.5);
        sideBLabel.position.x = -rackWidth / 2 - 2;
        sideBLabel.position.y = 5;
        labels.push(sideBLabel);
        scene.add(sideBLabel);
    }
}

/**
 * Create a side indicator label
 */
function createSideLabel(text, z) {
    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 60;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = text === 'A側' ? 'rgba(59, 130, 246, 0.8)' : 'rgba(245, 158, 11, 0.8)';
    ctx.roundRect(0, 0, 100, 60, 8);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 28px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 50, 30);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture });
    const sprite = new THREE.Sprite(material);

    sprite.position.z = z;
    sprite.scale.set(2, 1.2, 1);

    return sprite;
}

/**
 * Get current worker/person position
 */
function getWorkerPosition() {
    if (workerMarker) {
        return workerMarker.position.clone();
    }
    // Default position - right side of racks, in the aisle area
    const { boxesPerSide, slotWidth, rackDepth, centerGap } = CONFIG.rack;
    const rackWidth = boxesPerSide * slotWidth;
    const halfDepth = (rackDepth - centerGap) / 2;
    const rowZ = getRackWorldZ(0);

    return new THREE.Vector3(rackWidth / 2 + 8, 0, rowZ + halfDepth + 25);
}

/**
 * Create draggable worker/person marker
 */
function createWorkerMarker() {
    const initialPos = getWorkerPosition();

    // Create worker body - cylinder for body
    const bodyGeometry = new THREE.CylinderGeometry(1.2, 1.2, 3, 16);
    const bodyMaterial = new THREE.MeshStandardMaterial({
        color: 0xff6b35,  // Orange color for visibility
        roughness: 0.5,
        metalness: 0.3,
    });
    workerMarker = new THREE.Mesh(bodyGeometry, bodyMaterial);
    workerMarker.position.set(initialPos.x, 1.5, initialPos.z);
    workerMarker.castShadow = true;
    workerMarker.name = 'worker-marker';
    scene.add(workerMarker);

    // Add head sphere
    const headGeometry = new THREE.SphereGeometry(0.8, 16, 16);
    const headMaterial = new THREE.MeshStandardMaterial({
        color: 0xffcc99,  // Skin tone
        roughness: 0.6,
    });
    const head = new THREE.Mesh(headGeometry, headMaterial);
    head.position.y = 2.3;
    workerMarker.add(head);

    // Add base ring indicator
    const ringGeometry = new THREE.RingGeometry(1.8, 2.5, 32);
    const ringMaterial = new THREE.MeshBasicMaterial({
        color: 0xff6b35,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.6,
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -1.45;
    ring.name = 'worker-ring';
    workerMarker.add(ring);

    // Create worker label
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 80;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'rgba(255, 107, 53, 0.95)';
    ctx.roundRect(0, 0, 256, 80, 12);
    ctx.fill();

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.roundRect(3, 3, 250, 74, 10);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 28px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🧑 拖曳我設定起點', 128, 40);

    const texture = new THREE.CanvasTexture(canvas);
    const labelMaterial = new THREE.SpriteMaterial({ map: texture });
    workerLabel = new THREE.Sprite(labelMaterial);
    workerLabel.position.set(0, 4, 0);
    workerLabel.scale.set(5, 1.6, 1);
    workerMarker.add(workerLabel);

    // Create invisible drag plane for raycasting
    const planeGeometry = new THREE.PlaneGeometry(500, 500);
    const planeMaterial = new THREE.MeshBasicMaterial({
        visible: false,
        side: THREE.DoubleSide,
    });
    dragPlane = new THREE.Mesh(planeGeometry, planeMaterial);
    dragPlane.rotation.x = -Math.PI / 2;
    dragPlane.position.y = 0;
    scene.add(dragPlane);
}

/**
 * Create floor pallets - enlarged 4x
 * 3 pallets placed on the right side of racks
 */
function createFloorPallets() {
    const { boxesPerSide, slotWidth, rackDepth, centerGap } = CONFIG.rack;
    const rackWidth = boxesPerSide * slotWidth;
    const halfDepth = (rackDepth - centerGap) / 2;

    // Pallet dimensions - enlarged 4x from standard
    const palletWidth = 12.0;   // 3.0 * 4
    const palletDepth = 12.0;   // 3.0 * 4
    const palletHeight = 0.4;   // Slightly taller base
    const stackHeight = 4.0;    // 1.5 * ~2.5 for visibility

    // Position pallets on the RIGHT side of racks
    // Based on screenshot - to the right of R1-R4, roughly between R2 and R3 Z positions
    const r2Z = getRackWorldZ(1);
    const r3Z = getRackWorldZ(2);
    const palletBaseZ = (r2Z + r3Z) / 2;  // Between R2 and R3
    const palletStartX = rackWidth / 2 + 20;  // To the right of racks

    // Place 3 pallets in a column (vertically arranged)
    const palletSpacing = 15;  // Space between pallets

    const palletData = [
        { id: 'P1', x: palletStartX, z: palletBaseZ - palletSpacing, color: 0x8b4513, items: '原料 A' },
        { id: 'P2', x: palletStartX, z: palletBaseZ, color: 0xa0522d, items: '原料 B' },
        { id: 'P3', x: palletStartX, z: palletBaseZ + palletSpacing, color: 0xcd853f, items: '半成品' },
    ];

    palletData.forEach(pallet => {
        // Create a group to hold all pallet parts (for dragging together)
        const palletGroup = new THREE.Group();
        palletGroup.position.set(pallet.x, 0, pallet.z);
        palletGroup.name = `pallet-${pallet.id}`;
        palletGroup.userData = { type: 'pallet', id: pallet.id, items: pallet.items };
        scene.add(palletGroup);

        // Create pallet base (wooden planks) - relative to group
        const baseGeometry = new THREE.BoxGeometry(palletWidth, palletHeight, palletDepth);
        const baseMaterial = new THREE.MeshStandardMaterial({
            color: 0x8b7355,  // Wood color
            roughness: 0.9,
            metalness: 0.0,
        });
        const base = new THREE.Mesh(baseGeometry, baseMaterial);
        base.position.set(0, palletHeight / 2, 0);
        base.castShadow = true;
        base.receiveShadow = true;
        palletGroup.add(base);

        // Create stacked items on pallet
        const stackGeometry = new THREE.BoxGeometry(palletWidth - 0.3, stackHeight, palletDepth - 0.3);
        const stackMaterial = new THREE.MeshStandardMaterial({
            color: pallet.color,
            roughness: 0.6,
            metalness: 0.1,
        });
        const stack = new THREE.Mesh(stackGeometry, stackMaterial);
        stack.position.set(0, palletHeight + stackHeight / 2, 0);
        stack.castShadow = true;
        palletGroup.add(stack);

        // Add pallet label
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = 'rgba(139, 69, 19, 0.9)';
        ctx.roundRect(0, 0, 128, 64, 8);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 24px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(pallet.id, 64, 24);
        ctx.font = '16px Arial';
        ctx.fillText(pallet.items, 64, 48);

        const texture = new THREE.CanvasTexture(canvas);
        const labelMaterial = new THREE.SpriteMaterial({ map: texture });
        const label = new THREE.Sprite(labelMaterial);
        label.position.set(0, palletHeight + stackHeight + 1.5, 0);
        label.scale.set(2.5, 1.25, 1);
        palletGroup.add(label);

        // Store pallet reference
        floorPallets.push({
            id: pallet.id,
            group: palletGroup,
            base: base,
            stack: stack,
            label: label,
            items: pallet.items,
        });
    });

    // Add "落地棧板區" zone label
    const zoneCanvas = document.createElement('canvas');
    zoneCanvas.width = 256;
    zoneCanvas.height = 80;
    const zoneCtx = zoneCanvas.getContext('2d');

    zoneCtx.fillStyle = 'rgba(139, 69, 19, 0.85)';
    zoneCtx.roundRect(0, 0, 256, 80, 12);
    zoneCtx.fill();

    zoneCtx.strokeStyle = '#ffffff';
    zoneCtx.lineWidth = 2;
    zoneCtx.roundRect(3, 3, 250, 74, 10);
    zoneCtx.stroke();

    zoneCtx.fillStyle = '#ffffff';
    zoneCtx.font = 'bold 28px Arial';
    zoneCtx.textAlign = 'center';
    zoneCtx.textBaseline = 'middle';
    zoneCtx.fillText('📦 落地棧板區', 128, 40);

    const zoneTexture = new THREE.CanvasTexture(zoneCanvas);
    const zoneLabelMaterial = new THREE.SpriteMaterial({ map: zoneTexture });
    const zoneLabel = new THREE.Sprite(zoneLabelMaterial);
    zoneLabel.position.set(palletStartX, stackHeight + 4, palletBaseZ);
    zoneLabel.scale.set(8, 2.5, 1);  // Larger label for bigger pallets
    scene.add(zoneLabel);
    labels.push(zoneLabel);
}

/**
 * Search for a storage slot, pallet, or material
 * Supports:
 * - Storage slot ID: e.g., R1-A1-L1, R2-B3-L2
 * - Pallet ID: e.g., P1, P2, P3
 * - Material/Item name: searches for items stored in slots or pallets
 */
function searchBox(searchId) {
    // Clear previous highlight and arrows
    clearHighlight();
    clearNavigationArrows();

    if (!searchId || searchId.trim() === '') {
        return null;
    }

    const searchUpper = searchId.toUpperCase().trim();
    const searchLower = searchId.toLowerCase().trim();

    // 1. Search for storage slot by ID
    const matchingBox = boxes.find(box => {
        return box.userData.boxId.toUpperCase() === searchUpper;
    });

    if (matchingBox) {
        highlightSearchResult(matchingBox);
        createNavigationPath(matchingBox);
        focusOnBox(matchingBox);
        showBoxInfo(matchingBox);
        return { type: 'slot', ...matchingBox.userData };
    }

    // 2. Search for pallet by ID
    const matchingPallet = floorPallets.find(pallet => {
        return pallet.id.toUpperCase() === searchUpper;
    });

    if (matchingPallet) {
        highlightPallet(matchingPallet);
        createNavigationPathToPallet(matchingPallet);
        focusOnPallet(matchingPallet);
        showPalletInfo(matchingPallet);
        return { type: 'pallet', ...matchingPallet };
    }

    // 3. Search by material/item name (partial match)
    // Search in storage slots
    const matchingItemBox = boxes.find(box => {
        const item = box.userData.item || '';
        return item.toLowerCase().includes(searchLower);
    });

    if (matchingItemBox) {
        highlightSearchResult(matchingItemBox);
        createNavigationPath(matchingItemBox);
        focusOnBox(matchingItemBox);
        showBoxInfo(matchingItemBox);
        return { type: 'slot', searchedBy: 'item', ...matchingItemBox.userData };
    }

    // Search in pallets
    const matchingItemPallet = floorPallets.find(pallet => {
        return pallet.items.toLowerCase().includes(searchLower);
    });

    if (matchingItemPallet) {
        highlightPallet(matchingItemPallet);
        createNavigationPathToPallet(matchingItemPallet);
        focusOnPallet(matchingItemPallet);
        showPalletInfo(matchingItemPallet);
        return { type: 'pallet', searchedBy: 'item', ...matchingItemPallet };
    }

    return null;
}

/**
 * Highlight a pallet as search result
 */
function highlightPallet(pallet) {
    // Scale up the pallet group
    pallet.group.scale.set(1.2, 1.2, 1.2);

    // Change stack material to highlight color
    if (pallet.stack && pallet.stack.material) {
        pallet.stack.material.emissive = new THREE.Color(CONFIG.colors.highlight);
        pallet.stack.material.emissiveIntensity = 0.5;
    }
}

/**
 * Create navigation path to pallet
 */
function createNavigationPathToPallet(pallet) {
    const workerPos = getWorkerPosition();
    workerPos.y = 0.3;

    const palletPos = pallet.group.position.clone();

    // Simple direct path to pallet
    const waypoints = [workerPos.clone()];

    // Add waypoint at pallet approach position
    waypoints.push(new THREE.Vector3(palletPos.x - 3, 0.3, palletPos.z));
    waypoints.push(new THREE.Vector3(palletPos.x, 0.3, palletPos.z));

    // Create arrows along the path
    for (let i = 0; i < waypoints.length - 1; i++) {
        const start = waypoints[i];
        const end = waypoints[i + 1];
        const isLast = i === waypoints.length - 2;
        createArrow(start, end, isLast);
    }
}

/**
 * Focus camera on a pallet
 */
function focusOnPallet(pallet) {
    const palletPos = pallet.group.position.clone();
    const cameraOffset = new THREE.Vector3(-15, 12, 15);
    const targetCameraPos = palletPos.clone().add(cameraOffset);
    animateCamera(targetCameraPos, palletPos);
}

/**
 * Show pallet info in panel
 */
function showPalletInfo(pallet) {
    document.getElementById('info-title').textContent = `📦 棧板 ${pallet.id}`;
    document.getElementById('info-location').textContent = `落地棧板區 - ${pallet.id}`;
    document.getElementById('info-level').textContent = '地面層';
    document.getElementById('info-status').textContent = '使用中';
    document.getElementById('info-item').textContent = pallet.items || '-';

    infoPanel.classList.remove('hidden');
}

/**
 * Highlight a box as search result
 */
function highlightSearchResult(box) {
    highlightedBox = box;

    // Change color to highlight
    box.material.color.setHex(CONFIG.colors.highlight);
    box.material.emissive = new THREE.Color(CONFIG.colors.highlight);
    box.material.emissiveIntensity = 0.3;

    // Scale up
    box.scale.set(1.15, 1.15, 1.15);

    // Add pulsing glow effect
    const glowGeometry = new THREE.BoxGeometry(
        CONFIG.box.width * 1.3,
        CONFIG.box.height * 1.3,
        CONFIG.box.depth * 1.3
    );
    const glowMaterial = new THREE.MeshBasicMaterial({
        color: CONFIG.colors.highlight,
        transparent: true,
        opacity: 0.3,
        side: THREE.BackSide,
    });
    const glow = new THREE.Mesh(glowGeometry, glowMaterial);
    glow.name = 'highlight-glow';
    box.add(glow);
}

/**
 * Clear box and pallet highlight
 */
function clearHighlight() {
    // Clear box highlight
    if (highlightedBox) {
        // Restore original color
        highlightedBox.material.color.setHex(highlightedBox.userData.originalColor);
        highlightedBox.material.emissive = new THREE.Color(0x000000);
        highlightedBox.material.emissiveIntensity = 0;
        highlightedBox.scale.set(1, 1, 1);

        // Remove glow
        const glow = highlightedBox.getObjectByName('highlight-glow');
        if (glow) {
            highlightedBox.remove(glow);
            glow.geometry.dispose();
            glow.material.dispose();
        }

        highlightedBox = null;
    }

    // Clear pallet highlights
    floorPallets.forEach(pallet => {
        pallet.group.scale.set(1, 1, 1);
        if (pallet.stack && pallet.stack.material) {
            pallet.stack.material.emissive = new THREE.Color(0x000000);
            pallet.stack.material.emissiveIntensity = 0;
        }
    });
}

/**
 * Create navigation path from worker position to target box
 * Uses shortest path calculation - compares left vs right aisle routes
 */
function createNavigationPath(targetBox) {
    const { boxesPerSide, slotWidth, rackDepth, centerGap } = CONFIG.rack;
    const rackWidth = boxesPerSide * slotWidth;
    const halfDepth = (rackDepth - centerGap) / 2;

    const slot = targetBox.userData;
    const boxPos = targetBox.position.clone();

    // Get worker current position
    const workerPos = getWorkerPosition();
    workerPos.y = 0.3;

    // Target info
    const targetRowZ = getRackWorldZ(slot.row);
    const targetX = boxPos.x;

    // Target aisle Z position (in front of the shelf)
    const targetAisleZ = slot.side === 0
        ? targetRowZ - halfDepth - centerGap / 2 - 2   // A-side: approach from negative Z
        : targetRowZ + halfDepth + centerGap / 2 + 2;  // B-side: approach from positive Z

    // Aisle edge positions
    const rightAisleX = rackWidth / 2 + 3;
    const leftAisleX = -rackWidth / 2 - 3;

    // Calculate the shortest path by comparing two possible routes:
    // Route 1: Go via right aisle (positive X side)
    // Route 2: Go via left aisle (negative X side)

    function calculateRouteLength(viaAisleX) {
        // Step 1: Worker to aisle edge
        const d1 = Math.abs(workerPos.x - viaAisleX) + Math.abs(workerPos.z - workerPos.z);
        // Step 2: Move along aisle to target row's Z
        const d2 = Math.abs(workerPos.z - targetAisleZ);
        // Step 3: Move from aisle to target X
        const d3 = Math.abs(viaAisleX - targetX);
        return d1 + d2 + d3;
    }

    const rightRouteLength = calculateRouteLength(rightAisleX);
    const leftRouteLength = calculateRouteLength(leftAisleX);

    // Choose the shorter route
    const useRightAisle = rightRouteLength <= leftRouteLength;
    const chosenAisleX = useRightAisle ? rightAisleX : leftAisleX;

    // Build waypoints for the chosen route
    const waypoints = [];
    waypoints.push(workerPos.clone());

    // Step 1: Move to the chosen aisle edge (X direction)
    // Only add waypoint if we need to move significantly in X
    if (Math.abs(workerPos.x - chosenAisleX) > 2) {
        waypoints.push(new THREE.Vector3(chosenAisleX, 0.3, workerPos.z));
    }

    // Step 2: Move along the aisle to target row's Z position
    const currentX = waypoints[waypoints.length - 1].x;
    if (Math.abs(workerPos.z - targetAisleZ) > 2) {
        waypoints.push(new THREE.Vector3(currentX, 0.3, targetAisleZ));
    }

    // Step 3: Move into the row to reach target X
    waypoints.push(new THREE.Vector3(targetX, 0.3, targetAisleZ));

    // Step 4: Final approach to box position
    const finalZ = boxPos.z + (slot.side === 0 ? -2.5 : 2.5);
    waypoints.push(new THREE.Vector3(targetX, 0.3, finalZ));

    // Remove duplicate waypoints (where distance is too small)
    const filteredWaypoints = [waypoints[0]];
    for (let i = 1; i < waypoints.length; i++) {
        const prev = filteredWaypoints[filteredWaypoints.length - 1];
        const curr = waypoints[i];
        if (prev.distanceTo(curr) > 0.5) {
            filteredWaypoints.push(curr);
        }
    }

    // Create arrows along the path
    for (let i = 0; i < filteredWaypoints.length - 1; i++) {
        const start = filteredWaypoints[i];
        const end = filteredWaypoints[i + 1];
        const isLast = i === filteredWaypoints.length - 2;
        createArrow(start, end, isLast);
    }

    // Create vertical arrow pointing to the box level
    const lastWaypoint = filteredWaypoints[filteredWaypoints.length - 1];
    createVerticalArrow(
        new THREE.Vector3(lastWaypoint.x, 0.5, lastWaypoint.z),
        new THREE.Vector3(targetX, boxPos.y - 0.3, boxPos.z + (slot.side === 0 ? -1 : 1)),
        true
    );
}

/**
 * Create an arrow between two points
 */
function createArrow(start, end, isLast = false) {
    const direction = new THREE.Vector3().subVectors(end, start);
    const length = direction.length();
    direction.normalize();

    // Arrow shaft
    const arrowColor = isLast ? 0xff3366 : CONFIG.colors.arrow;

    const shaftGeometry = new THREE.CylinderGeometry(0.08, 0.08, length - 0.5, 8);
    const shaftMaterial = new THREE.MeshBasicMaterial({ color: arrowColor });
    const shaft = new THREE.Mesh(shaftGeometry, shaftMaterial);

    // Position and rotate shaft
    const midpoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    shaft.position.copy(midpoint);

    // Calculate rotation
    const axis = new THREE.Vector3(0, 1, 0);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(axis, direction);
    shaft.quaternion.copy(quaternion);

    scene.add(shaft);
    navigationArrows.push(shaft);

    // Arrow head
    const headGeometry = new THREE.ConeGeometry(0.25, 0.5, 8);
    const headMaterial = new THREE.MeshBasicMaterial({ color: arrowColor });
    const head = new THREE.Mesh(headGeometry, headMaterial);

    head.position.copy(end);
    head.quaternion.copy(quaternion);

    scene.add(head);
    navigationArrows.push(head);
}

/**
 * Create vertical arrow pointing up to box level
 */
function createVerticalArrow(start, end, isTarget = false) {
    const direction = new THREE.Vector3().subVectors(end, start);
    const length = direction.length();
    direction.normalize();

    const arrowColor = isTarget ? 0xff3366 : CONFIG.colors.arrow;

    // Shaft
    const shaftGeometry = new THREE.CylinderGeometry(0.06, 0.06, length - 0.3, 8);
    const shaftMaterial = new THREE.MeshBasicMaterial({
        color: arrowColor,
        transparent: true,
        opacity: 0.8
    });
    const shaft = new THREE.Mesh(shaftGeometry, shaftMaterial);

    const midpoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    shaft.position.copy(midpoint);

    const axis = new THREE.Vector3(0, 1, 0);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(axis, direction);
    shaft.quaternion.copy(quaternion);

    scene.add(shaft);
    navigationArrows.push(shaft);

    // Head
    const headGeometry = new THREE.ConeGeometry(0.2, 0.4, 8);
    const headMaterial = new THREE.MeshBasicMaterial({
        color: arrowColor,
        transparent: true,
        opacity: 0.8
    });
    const head = new THREE.Mesh(headGeometry, headMaterial);

    head.position.copy(end);
    head.quaternion.copy(quaternion);

    scene.add(head);
    navigationArrows.push(head);
}

/**
 * Clear navigation arrows
 */
function clearNavigationArrows() {
    navigationArrows.forEach(arrow => {
        scene.remove(arrow);
        if (arrow.geometry) arrow.geometry.dispose();
        if (arrow.material) arrow.material.dispose();
    });
    navigationArrows = [];
}

/**
 * Focus camera on a specific box
 */
function focusOnBox(box) {
    const boxPos = box.position.clone();
    const slot = box.userData;

    // Camera position based on which side the box is on
    const cameraOffset = slot.side === 0
        ? new THREE.Vector3(8, 6, -12)
        : new THREE.Vector3(8, 6, 12);

    const targetCameraPos = boxPos.clone().add(cameraOffset);

    animateCamera(targetCameraPos, boxPos);
}

/**
 * Show storage slot info in panel
 */
function showBoxInfo(box) {
    const data = box.userData;
    const hasItem = data.item && data.item !== '-' && data.item !== '';
    const sideLabel = data.side === 0 ? 'A側' : 'B側';

    document.getElementById('info-title').textContent = `� 儲位 ${data.boxId}`;
    document.getElementById('info-location').textContent = `${data.boxId} (${sideLabel})`;
    document.getElementById('info-level').textContent = `第 ${data.level + 1} 層`;
    document.getElementById('info-status').textContent = hasItem ? '✅ 有存放' : '⬜ 空置';
    document.getElementById('info-item').textContent = hasItem ? data.item : '(空位)';

    infoPanel.classList.remove('hidden');
}

/**
 * Setup event listeners for UI interactions
 */
function setupEventListeners() {
    // Window resize
    window.addEventListener('resize', onWindowResize);

    // Mouse click for box selection
    renderer.domElement.addEventListener('click', onMouseClick);

    // Close info panel
    closeInfoBtn.addEventListener('click', () => {
        infoPanel.classList.add('hidden');
    });

    // Toggle controls
    toggleLabels.addEventListener('change', (e) => {
        labels.forEach(label => label.visible = e.target.checked);
        boxLabels.forEach(label => label.visible = e.target.checked);
    });

    toggleBoxes.addEventListener('change', (e) => {
        boxes.forEach(box => box.visible = e.target.checked);
    });

    toggleGrid.addEventListener('change', (e) => {
        gridHelper.visible = e.target.checked;
    });

    // View angle buttons
    viewButtons.front.addEventListener('click', () => setViewAngle('front'));
    viewButtons.top.addEventListener('click', () => setViewAngle('top'));
    viewButtons.side.addEventListener('click', () => setViewAngle('side'));
    viewButtons.iso.addEventListener('click', () => setViewAngle('iso'));

    // Search functionality
    const searchInput = document.getElementById('search-input');
    const searchBtn = document.getElementById('search-btn');
    const clearBtn = document.getElementById('clear-search');

    if (searchBtn) {
        searchBtn.addEventListener('click', () => {
            const result = searchBox(searchInput.value);
            if (!result) {
                document.getElementById('search-result').textContent = '找不到該儲位或棧板';
                document.getElementById('search-result').classList.add('error');
            } else {
                const typeLabel = result.type === 'pallet' ? '棧板' : '儲位';
                const id = result.type === 'pallet' ? result.id : result.boxId;
                document.getElementById('search-result').textContent = `找到 ${typeLabel}: ${id}`;
                document.getElementById('search-result').classList.remove('error');
            }
        });
    }

    if (searchInput) {
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                searchBtn.click();
            }
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            clearHighlight();
            clearNavigationArrows();
            searchInput.value = '';
            document.getElementById('search-result').textContent = '';
            infoPanel.classList.add('hidden');
        });
    }

    // Worker marker drag functionality
    setupWorkerDrag();
}

/**
 * Setup drag functionality for worker marker and pallets
 */
function setupWorkerDrag() {
    let dragOffset = new THREE.Vector3();
    let draggingObject = null;  // Can be 'worker' or a pallet group
    let draggingType = null;    // 'worker' or 'pallet'

    renderer.domElement.addEventListener('mousedown', (event) => {
        mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

        raycaster.setFromCamera(mouse, camera);

        // Check if clicking on worker marker
        const workerIntersects = raycaster.intersectObject(workerMarker, true);
        if (workerIntersects.length > 0) {
            isDraggingWorker = true;
            draggingObject = workerMarker;
            draggingType = 'worker';
            controls.enabled = false;

            const intersectPoint = workerIntersects[0].point;
            dragOffset.copy(workerMarker.position).sub(new THREE.Vector3(intersectPoint.x, 0, intersectPoint.z));
            dragOffset.y = 0;

            renderer.domElement.style.cursor = 'grabbing';
            workerMarker.scale.set(1.2, 1.2, 1.2);
            return;
        }

        // Check if clicking on any pallet
        for (const pallet of floorPallets) {
            const palletIntersects = raycaster.intersectObject(pallet.group, true);
            if (palletIntersects.length > 0) {
                isDraggingWorker = true;  // Reuse flag for general dragging
                draggingObject = pallet.group;
                draggingType = 'pallet';
                controls.enabled = false;

                const intersectPoint = palletIntersects[0].point;
                dragOffset.copy(pallet.group.position).sub(new THREE.Vector3(intersectPoint.x, 0, intersectPoint.z));
                dragOffset.y = 0;

                renderer.domElement.style.cursor = 'grabbing';
                pallet.group.scale.set(1.1, 1.1, 1.1);
                return;
            }
        }
    });

    renderer.domElement.addEventListener('mousemove', (event) => {
        mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

        if (!isDraggingWorker) {
            // Hover detection for cursor change
            raycaster.setFromCamera(mouse, camera);

            // Check worker
            let hovering = raycaster.intersectObject(workerMarker, true).length > 0;

            // Check pallets
            if (!hovering) {
                for (const pallet of floorPallets) {
                    if (raycaster.intersectObject(pallet.group, true).length > 0) {
                        hovering = true;
                        break;
                    }
                }
            }

            renderer.domElement.style.cursor = hovering ? 'grab' : 'default';
            return;
        }

        // Dragging - update position
        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObject(dragPlane);

        if (intersects.length > 0 && draggingObject) {
            const newPos = intersects[0].point;

            if (draggingType === 'worker') {
                draggingObject.position.x = newPos.x + dragOffset.x;
                draggingObject.position.z = newPos.z + dragOffset.z;
                draggingObject.position.y = 1.5;
                clearNavigationArrows();
            } else if (draggingType === 'pallet') {
                draggingObject.position.x = newPos.x + dragOffset.x;
                draggingObject.position.z = newPos.z + dragOffset.z;
                draggingObject.position.y = 0;
            }
        }
    });

    renderer.domElement.addEventListener('mouseup', () => {
        if (isDraggingWorker && draggingObject) {
            isDraggingWorker = false;
            controls.enabled = true;
            renderer.domElement.style.cursor = 'default';

            if (draggingType === 'worker') {
                workerMarker.scale.set(1, 1, 1);
                if (highlightedBox) {
                    clearNavigationArrows();
                    createNavigationPath(highlightedBox);
                }
            } else if (draggingType === 'pallet') {
                draggingObject.scale.set(1, 1, 1);
            }

            draggingObject = null;
            draggingType = null;
        }
    });

    // Handle mouse leaving canvas
    renderer.domElement.addEventListener('mouseleave', () => {
        if (isDraggingWorker && draggingObject) {
            isDraggingWorker = false;
            controls.enabled = true;
            renderer.domElement.style.cursor = 'default';

            if (draggingType === 'worker') {
                workerMarker.scale.set(1, 1, 1);
            } else if (draggingType === 'pallet') {
                draggingObject.scale.set(1, 1, 1);
            }

            draggingObject = null;
            draggingType = null;
        }
    });
}

/**
 * Handle window resize
 */
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

/**
 * Handle mouse click for box selection
 */
function onMouseClick(event) {
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(boxes);

    if (intersects.length > 0) {
        const selectedBox = intersects[0].object;
        showBoxInfo(selectedBox);
    }
}

/**
 * Get status display text
 */
function getStatusText(status) {
    const statusMap = {
        occupied: '已佔用',
        available: '可用',
        reserved: '預留中',
    };
    return statusMap[status] || status;
}

/**
 * Set camera view angle - adjusted for larger warehouse
 */
function setViewAngle(view) {
    const targetPosition = new THREE.Vector3();
    const targetLookAt = new THREE.Vector3(0, 5, 20);

    switch (view) {
        case 'front':
            targetPosition.set(0, 15, 80);
            break;
        case 'top':
            targetPosition.set(0, 100, 30);
            targetLookAt.set(0, 0, 20);
            break;
        case 'side':
            targetPosition.set(60, 20, 20);
            break;
        case 'iso':
        default:
            targetPosition.set(50, 45, 80);
            break;
    }

    animateCamera(targetPosition, targetLookAt);
}

/**
 * Animate camera to target position
 */
function animateCamera(targetPosition, targetLookAt) {
    const startPosition = camera.position.clone();
    const startLookAt = controls.target.clone();
    let progress = 0;

    const animateCam = () => {
        progress += 0.025;

        if (progress < 1) {
            const t = 1 - Math.pow(1 - progress, 3);

            camera.position.lerpVectors(startPosition, targetPosition, t);
            controls.target.lerpVectors(startLookAt, targetLookAt, t);

            requestAnimationFrame(animateCam);
        } else {
            camera.position.copy(targetPosition);
            controls.target.copy(targetLookAt);
        }
    };

    animateCam();
}

/**
 * Animation loop
 */
function animate() {
    requestAnimationFrame(animate);

    // Animate worker marker ring
    if (workerMarker) {
        const ring = workerMarker.getObjectByName('worker-ring');
        if (ring) {
            ring.rotation.z += 0.02;
        }
    }

    // Animate highlighted box
    if (highlightedBox) {
        const time = Date.now() * 0.003;
        const scale = 1.1 + Math.sin(time) * 0.05;
        highlightedBox.scale.set(scale, scale, scale);

        const glow = highlightedBox.getObjectByName('highlight-glow');
        if (glow) {
            glow.material.opacity = 0.2 + Math.sin(time * 2) * 0.1;
        }
    }

    // Animate navigation arrows pulsing
    navigationArrows.forEach((arrow, index) => {
        const time = Date.now() * 0.005 + index * 0.5;
        if (arrow.material) {
            arrow.material.opacity = 0.6 + Math.sin(time) * 0.3;
        }
    });

    controls.update();
    renderer.render(scene, camera);
}

// Make search function globally accessible
window.searchBox = searchBox;
window.clearHighlight = clearHighlight;
window.clearNavigationArrows = clearNavigationArrows;

// Initialize the scene
init();
