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
        baseHeight: 3.0,      // Raised: empty space under the racks for AGV passage
        agvClearance: 0.2,    // Clearance between AGV top and lowest shelf level
    },
    // Grid cells occupied by obstacles (racks with full pallets or floor pallets)
    collision: {
        rackHalfWidth: 0.6,     // Obstacle half-size around a full rack cell
        palletHalfWidth: 6.0,   // Obstacle half-size around a floor pallet
    },
    agv: {
        bodyLength: 3.6,      // Along Z (drive direction)
        bodyWidth: 2.6,       // Across X
        bodyHeight: 1.0,
        forkLength: 1.6,      // Front fork reach
        liftHeight: 0.9,      // Fork lift for carrying loads
        speed: 14,            // AGV travel speed (units/sec)
        turnSpeed: 2.4,       // Radians per second
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
let agv = null;               // AGV vehicle group
let agvLabel = null;          // AGV status label
let agvJob = null;            // AGV delivery job plan
let agvCarried = null;        // Carried load info while moving
let agvPath = [];             // Remaining waypoints for the AGV

// Obstacle registry (fills after racks/pallets are created)
const obstacles = [];         // { minX, maxX, minZ, maxZ } AABBs that block AGV & worker

// Keyboard control + follow camera state
const keys = new Set();                    // Currently held keys (KeyboardEvent.code)
let cameraFollow = false;                  // Follow camera enabled
let followZoom = 16;                       // Follow camera distance (mouse wheel adjustable)
let cameraFollowYaw = Math.PI;             // Follow camera orbit angle around the worker
const followCamPos = new THREE.Vector3();  // Smoothed camera position while following
const followCamLook = new THREE.Vector3(); // Smoothed look-at point while following
let workerYaw = 0;                         // Worker facing angle (radians)
let bobPhase = 0;                          // Head-bob phase while walking
let bobAmp = 0;                            // Head-bob amount 0..1 (fades in/out)
let lastPathRecalc = 0;                    // Last navigation-arrow recompute (ms)
let clock = null;                          // THREE.Clock for per-frame delta time
let lastAgvObstacleCheck = 0;              // Debounce for mid-route re-planning
const checkpoint = { meeting: null, cancelled: false };  // AGV drop-off point set by the worker

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

    // Create the AGV vehicle
    createAGV();
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

    // Top-down cover so the raised third deck is visible from oblique views
    const topLight = new THREE.DirectionalLight(0xffffff, 0.55);
    topLight.position.set(-20, 60, -25);
    topLight.target.position.set(0, 0, 5);
    scene.add(topLight);
    scene.add(topLight.target);
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
 * Y offset of the bottom-most shelf deck (racks are raised for AGV clearance)
 */
function getRackBaseY() {
    return CONFIG.rack.baseHeight;
}

/**
 * Rack world position (3D group origin)
 */
function getRackWorldPosition(row) {
    return new THREE.Vector3(0, getRackBaseY(), getRackWorldZ(row));
}

/** Raised shelf Y for a level (world space). */
function getLevelY(level) {
    return getRackBaseY() + level * CONFIG.rack.slotHeight;
}

/**
 * Create storage rack structures - 2 sides per level, 3 boxes per side
 */
function createRacks() {
    const { rows, boxesPerSide, levels, slotWidth, slotHeight, rackDepth, frameThickness, centerGap, baseHeight } = CONFIG.rack;

    const frameMaterial = new THREE.MeshStandardMaterial({
        color: CONFIG.colors.frame,
        roughness: 0.5,
        metalness: 0.7,
    });
    const shelfMaterial = new THREE.MeshStandardMaterial({
        color: 0x334155,
        roughness: 0.6,
        metalness: 0.3,
    });

    const rackWidth = boxesPerSide * slotWidth;
    const rackHeight = levels * slotHeight;
    const halfDepth = (rackDepth - centerGap) / 2;
    const postHeight = baseHeight + rackHeight;

    // Register a whole-rack row obstacle (worker must walk around; AGV also routes around it)
    for (let row = 0; row < rows; row++) {
        const rowZmin = getRackWorldZ(row) - halfDepth - centerGap / 2;
        const rowZmax = getRackWorldZ(row) + halfDepth + centerGap / 2;
        obstacles.push({
            minX: -rackWidth / 2 - CONFIG.collision.rackHalfWidth,
            maxX: rackWidth / 2 + CONFIG.collision.rackHalfWidth,
            minZ: rowZmin - CONFIG.collision.rackHalfWidth,
            maxZ: rowZmax + CONFIG.collision.rackHalfWidth,
        });
    }

    for (let row = 0; row < rows; row++) {
        const rackGroup = new THREE.Group();
        rackGroup.name = 'rack-group';
        rackGroup.position.set(0, baseHeight, getRackWorldZ(row));
        scene.add(rackGroup);

        const localZmin = -(halfDepth + centerGap / 2);
        const localZmax = halfDepth + centerGap / 2;

        // legs x positions
        const allPosts = [];
        for (let c = 0; c <= boxesPerSide; c++) {
            allPosts.push(c * slotWidth - rackWidth / 2);
        }

        // legs z positions: one near each end of each side
        const legZs = [
            localZmin + frameThickness,      // A outer
            localZmin + halfDepth - frameThickness,    // A inner
            localZmax - halfDepth + frameThickness,    // B inner
            localZmax - frameThickness,      // B outer
        ];

        // Legs (tall vertical supports, from floor to top of rack)
        allPosts.forEach((postX) => {
            legZs.forEach((legZ) => {
                const legGeometry = new THREE.BoxGeometry(frameThickness, postHeight, frameThickness);
                const leg = new THREE.Mesh(legGeometry, frameMaterial);
                leg.position.set(postX, postHeight / 2, legZ);
                leg.castShadow = true;
                rackGroup.add(leg);
            });
        });

        // Cross beams under the two lowest levels to reinforce the undercarriage
        [baseHeight, baseHeight + slotHeight].forEach((levelY) => {
            allPosts.forEach((postX) => {
                const crossGeom = new THREE.BoxGeometry(frameThickness, frameThickness, rackDepth);
                const cross = new THREE.Mesh(crossGeom, frameMaterial);
                cross.position.set(postX, levelY - frameThickness / 2, 0);
                cross.castShadow = true;
                rackGroup.add(cross);
            });
        });

        // Shelf decks at each level (both sides)
        for (let level = 0; level <= levels; level++) {
            const beamY = baseHeight + level * slotHeight;
            ['A', 'B'].forEach((side) => {
                const sideZ = side === 'A' ? localZmin + halfDepth / 2 : localZmax - halfDepth / 2;
                [localZmin + frameThickness / 2, localZmax - frameThickness / 2].forEach((edgeZ) => {
                    const beamGeometry = new THREE.BoxGeometry(rackWidth, frameThickness, frameThickness);
                    const beam = new THREE.Mesh(beamGeometry, frameMaterial);
                    beam.position.set(0, beamY, edgeZ);
                    beam.castShadow = true;
                    rackGroup.add(beam);
                });

                if (level < levels) {
                    const shelfGeometry = new THREE.BoxGeometry(rackWidth - frameThickness, frameThickness / 2, halfDepth - frameThickness);
                    const shelf = new THREE.Mesh(shelfGeometry, shelfMaterial);
                    shelf.position.set(0, beamY + frameThickness, sideZ);
                    shelf.receiveShadow = true;
                    rackGroup.add(shelf);
                }
            });

            // Longitudinal cross beams to hold the two sides together
            [localZmin, localZmax].forEach((edgeZ) => {
                const longGeom = new THREE.BoxGeometry(roomWidth(rackWidth), frameThickness, frameThickness);
                const longBeam = new THREE.Mesh(longGeom, frameMaterial);
                longBeam.position.set(0, beamY, edgeZ);
                rackGroup.add(longBeam);
            });
        }
    }
}

/**
 * Small helper used to shrink the longitudinal beams slightly
 */
function roomWidth(w) {
    return w - 0.1;
}

/**
 * Mesh representing a full/occupied slot box positioned on a shelf
 */
function createOccupiedBoxMesh(slot, boxMesh) {
    const pos = getBoxWorldPosition(slot);
    boxMesh.position.copy(pos);
    boxMesh.geometry = new THREE.BoxGeometry(CONFIG.box.width, CONFIG.box.height, CONFIG.box.depth);
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
    const y = getRackBaseY() + slot.level * slotHeight + height / 2 + frameThickness;

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

        label.position.set(rackWidth / 2 + 3, 9 + getRackBaseY(), rowZ);
        label.scale.set(5, 1.6, 1);

        labels.push(label);
        scene.add(label);

        // Side A label (left/front)
        const sideALabel = createSideLabel('A側', rowZ - halfDepth - centerGap / 2 - 1.5);
        sideALabel.position.x = -rackWidth / 2 - 2;
        sideALabel.position.y = 5 + getRackBaseY();
        labels.push(sideALabel);
        scene.add(sideALabel);

        // Side B label (right/back)
        const sideBLabel = createSideLabel('B側', rowZ + halfDepth + centerGap / 2 + 1.5);
        sideBLabel.position.x = -rackWidth / 2 - 2;
        sideBLabel.position.y = 5 + getRackBaseY();
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

    // Add nose cone to make facing direction visible when walking
    const nose = new THREE.Mesh(
        new THREE.ConeGeometry(0.25, 0.7, 12),
        new THREE.MeshStandardMaterial({ color: 0xe8590c, roughness: 0.5 })
    );
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 2.3, 1.1);
    workerMarker.add(nose);

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
    ctx.fillText('🧑 WASD 移動 · F 視角跟隨', 128, 40);

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
 * Create AGV (automated guided vehicle) mesh and default parked pose.
 */
function createAGV() {
    const { bodyLength, bodyWidth, bodyHeight, forkLength } = CONFIG.agv;

    agv = new THREE.Group();
    agv.name = 'agv';
    agv.position.set(-rackWidthHalf() - 10, 0, getRackWorldZ(3) + 14);

    const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xf97316, roughness: 0.45, metalness: 0.35 });
    const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.6, metalness: 0.3 });

    // Body
    const body = new THREE.Mesh(new THREE.BoxGeometry(bodyWidth, bodyHeight, bodyLength), bodyMaterial);
    body.position.y = 0.3 + bodyHeight / 2;
    body.castShadow = true;
    agv.add(body);

    // Driverless cab (low bump)
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(bodyWidth * 0.8, 0.7, bodyLength * 0.35), darkMaterial);
    cabin.position.set(0, 0.3 + bodyHeight + 0.35, -bodyLength / 4);
    cabin.castShadow = true;
    agv.add(cabin);

    // Rear counterweight
    const counterweight = new THREE.Mesh(new THREE.BoxGeometry(bodyWidth * 0.95, bodyHeight * 0.85, bodyLength * 0.2), darkMaterial);
    counterweight.position.set(0, 0.3 + bodyHeight * 0.9, -bodyLength / 2 - 0.1);
    counterweight.castShadow = true;
    agv.add(counterweight);

    // Wheels: 4 small cylinders
    const wheelGeometry = new THREE.CylinderGeometry(0.45, 0.45, 0.4, 20);
    wheelGeometry.rotateZ(Math.PI / 2);
    [-bodyWidth / 2 + 0.3, bodyWidth / 2 - 0.3].forEach((wx) => {
        [-bodyLength / 3, bodyLength / 3].forEach((wz) => {
            const wheel = new THREE.Mesh(wheelGeometry, darkMaterial);
            wheel.position.set(wx, 0.45, wz);
            wheel.castShadow = true;
            agv.add(wheel);
        });
    });

    // Warning beacon
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 12), new THREE.MeshStandardMaterial({
        color: 0xffcc00,
        emissive: 0xffaa00,
        emissiveIntensity: 0.6,
    }));
    beacon.position.set(0, 0.3 + bodyHeight + 0.8, -bodyLength / 4);
    beacon.name = 'agv-beacon';
    agv.add(beacon);

    // Fork frame (front mast) - lifts and lowers like a real fork AGV
    const mast = new THREE.Group();
    mast.name = 'agv-mast';
    agv.add(mast);
    const mastColumn = new THREE.Mesh(
        new THREE.BoxGeometry(bodyWidth * 0.9, 3.4, 0.3),
        darkMaterial
    );
    mastColumn.position.set(0, 0.3 + bodyHeight / 2 + 1.7, bodyLength / 2);
    mastColumn.castShadow = true;
    mast.add(mastColumn);

    const forkBeam = new THREE.Mesh(
        new THREE.BoxGeometry(bodyWidth * 0.95, 0.25, 0.4),
        bodyMaterial
    );
    forkBeam.position.set(0, CONFIG.agv.liftHeight, bodyLength / 2);
    forkBeam.castShadow = true;
    forkBeam.name = 'agv-fork';
    mast.add(forkBeam);

    [-bodyWidth * 0.4, bodyWidth * 0.4].forEach((fx) => {
        const tine = new THREE.Mesh(
            new THREE.BoxGeometry(0.18, 0.15, forkLength + 0.5),
            darkMaterial
        );
        tine.position.set(fx, CONFIG.agv.liftHeight - 0.1, bodyLength / 2 + forkLength / 2);
        tine.castShadow = true;
        mast.add(tine);
    });

    scene.add(agv);

    // Create AGV label
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 80;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(249, 115, 22, 0.95)';
    ctx.roundRect(0, 0, 256, 80, 12);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.roundRect(3, 3, 250, 74, 10);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 30px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🤖 AGV 待命', 128, 40);

    const texture = new THREE.CanvasTexture(canvas);
    const labelMaterial = new THREE.SpriteMaterial({ map: texture });
    agvLabel = new THREE.Sprite(labelMaterial);
    agvLabel.position.set(0, 4.6, 0);
    agvLabel.scale.set(5.5, 1.7, 1);
    agv.add(agvLabel);
}

/** Rack half-width helper */
function rackWidthHalf() {
    return CONFIG.rack.boxesPerSide * CONFIG.rack.slotWidth / 2;
}

/**
 * Update AGV status label text (both 3D sprite and HTML status card)
 */
function setAgvLabel(text) {
    if (agv && agvLabel) {
        const canvas = agvLabel.material.map.image;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(249, 115, 22, 0.95)';
        ctx.roundRect(0, 0, 256, 80, 12);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.roundRect(3, 3, 250, 74, 10);
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 26px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 128, 40);
        agvLabel.material.map.needsUpdate = true;
    }

    // Mirror the status in the HTML card (150ms throttle)
    const statusCard = document.getElementById('agv-status');
    if (statusCard) statusCard.textContent = text;
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

    // Register pallets as solid obstacles (AGV and worker cannot walk through them)
    palletData.forEach((pd) => {
        obstacles.push({
            minX: pd.x - CONFIG.collision.palletHalfWidth,
            maxX: pd.x + CONFIG.collision.palletHalfWidth,
            minZ: pd.z - CONFIG.collision.palletHalfWidth,
            maxZ: pd.z + CONFIG.collision.palletHalfWidth,
            palletId: pd.id,
        });
        floorPallets[floorPallets.length - 1].obstacleRef = obstacles[obstacles.length - 1];
    });
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
        agvDispatchToSlot(matchingBox);
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
        agvDispatchToPallet(matchingPallet);
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
        agvDispatchToSlot(matchingItemBox);
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
        agvDispatchToPallet(matchingItemPallet);
        return { type: 'pallet', searchedBy: 'item', ...matchingItemPallet };
    }

    return null;
}

/**
 * Dispatch the AGV to fetch a slot box and bring it in front of the worker.
 */
function agvDispatchToSlot(box) {
    if (!agv) return;
    agvReturnCargo();
    const slot = box.userData;
    agvSchedule({
        kind: 'slot',
        box: box,
        label: `🤖 取 ${slot.boxId}`,
        itemLabel: `${slot.boxId}${slot.item ? ' · ' + slot.item : ''}`,
    });
}

/**
 * Dispatch the AGV to fetch a floor pallet and bring it in front of the worker.
 */
function agvDispatchToPallet(pallet) {
    if (!agv) return;
    agvReturnCargo();
    agvSchedule({
        kind: 'pallet',
        pallet: pallet,
        label: `🤖 取 ${pallet.id}`,
        itemLabel: `${pallet.id}${pallet.items ? ' · ' + pallet.items : ''}`,
    });
}

/**
 * Cancel any running job and restore the carried cargo to its previous position
 */
function agvResetJob() {
    agvReturnCargo();
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

/* ==================== AGV path & mission logic ==================== */

/**
 * Check if a point (x, z) is inside any obstacle the AGV / worker must not cross.
 * All registered obstacles (rack rows, occupied shelf cells, floor pallets) block both.
 */
function agvCheckCollision(x, z, isAgv = true) {
    const pad = isAgv ? 0.7 : 0.9;   // AGV body / worker body clearance
    for (const obs of obstacles) {
        if (x > obs.minX - pad && x < obs.maxX + pad && z > obs.minZ - pad && z < obs.maxZ + pad) {
            return true;
        }
    }
    return false;
}

/**
 * Ground obstacle test used for the walking worker.
 * Same registry as the AGV: racks, occupied shelf cells, floor pallets all block.
 */
function groundBlockedAt(x, z) {
    const padWorker = 1.0;   // Worker body radius keeping clear of obstacles
    for (const obs of obstacles) {
        if (x > obs.minX - padWorker && x < obs.maxX + padWorker &&
            z > obs.minZ - padWorker && z < obs.maxZ + padWorker) {
            return true;
        }
    }
    return false;
}

/**
 * Simple 2D grid A* planner on a coarse walkable grid.
 * Returns an array of {x, z} waypoints (excluding the start point).
 */
function agvPlanPath(startX, startZ, goalX, goalZ, isAgv) {
    const cell = 1.5;
    const minX = -80, maxX = 80, minZ = -60, maxZ = 90;
    const cols = Math.ceil((maxX - minX) / cell);
    const rows = Math.ceil((maxZ - minZ) / cell);
    const nodeIndex = (cx, rz) => rz * cols + cx;

    const blocked = new Uint8Array(cols * rows);
    for (let rz = 0; rz < rows; rz++) {
        for (let cx = 0; cx < cols; cx++) {
            const wx = minX + (cx + 0.5) * cell;
            const wz = minZ + (rz + 0.5) * cell;
            blocked[nodeIndex(cx, rz)] = agvCheckCollision(wx, wz, isAgv) ? 1 : 0;
        }
    }

    const toCell = (wx, wz) => {
        const cx = Math.min(cols - 1, Math.max(0, Math.floor((wx - minX) / cell)));
        const rz = Math.min(rows - 1, Math.max(0, Math.floor((wz - minZ) / cell)));
        return { cx, rz };
    };

    const startCell = toCell(startX, startZ);
    const goalCell = toCell(goalX, goalZ);

    // If start is blocked, nudge it to a nearby free cell
    if (blocked[nodeIndex(startCell.cx, startCell.rz)]) {
        const fix = findNearbyFreeCell(startCell.cx, startCell.rz, blocked, cols, rows);
        if (fix) {
            startCell.cx = fix.cx;
            startCell.rz = fix.rz;
        }
    }

    // A* search
    const open = [{ cx: startCell.cx, rz: startCell.rz, g: 0, f: 0, parent: null }];
    const seen = new Map();
    seen.set(nodeIndex(startCell.cx, startCell.rz), open[0]);

    let best = null;
    let iter = 0;
    while (open.length && iter < 6000) {
        iter++;
        open.sort((a, b) => a.f - b.f);
        const cur = open.shift();

        if (cur.cx === goalCell.cx && cur.rz === goalCell.rz) {
            best = cur;
            break;
        }

        // 8-connected neighbors with diagonal cost 1.414
        for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dz === 0) continue;
                const nx = cur.cx + dx;
                const nz = cur.rz + dz;
                if (nx < 0 || nx >= cols || nz < 0 || nz >= rows) continue;
                if (blocked[nodeIndex(nx, nz)]) continue;
                // Prevent diagonal corner cutting
                if (dx !== 0 && dz !== 0) {
                    if (blocked[nodeIndex(cur.cx + dx, cur.rz)] || blocked[nodeIndex(cur.cx, cur.rz + dz)]) continue;
                }
                const stepCost = (dx !== 0 && dz !== 0) ? 1.414 : 1;
                const g = cur.g + stepCost;
                const h = Math.hypot(goalCell.cx - nx, goalCell.rz - nz);
                const key = nodeIndex(nx, nz);
                if (seen.has(key) && seen.get(key).g <= g) continue;

                const node = { cx: nx, rz: nz, g, f: g + h, parent: cur };
                seen.set(key, node);
                open.push(node);
            }
        }
    }

    if (!best) {
        // Fall back to a straight line (allows the AGV to be visually blocked)
        return [{ x: goalX, z: goalZ }];
    }

    // Backtrack
    const cells = [];
    let n = best;
    while (n) {
        cells.push({ x: minX + (n.cx + 0.5) * cell, z: minZ + (n.rz + 0.5) * cell });
        n = n.parent;
    }
    cells.reverse();
    cells.shift();   // Drop the start cell (AGV is already there)

    // Append the exact goal point
    cells.push({ x: goalX, z: goalZ });
    return cells;
}

/**
 * Breadth-first search outward to find the nearest cell that is not blocked
 */
function findNearbyFreeCell(cx, cz, blocked, cols, rows) {
    const radius = 20;
    for (let r = 1; r <= radius; r++) {
        for (let dz = -r; dz <= r; dz++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
                const nx = cx + dx;
                const nz = cz + dz;
                if (nx < 0 || nx >= cols || nz < 0 || nz >= rows) continue;
                if (!blocked[nz * cols + nx]) return { cx: nx, rz: nz };
            }
        }
    }
    return null;
}

/**
 * Schedule the AGV to travel to the pallet/box and then to the worker.
 * This sets up the job; the mission is executed in the animation loop.
 */
function agvSchedule(target) {
    agvJob = {
        stage: 'toCargo',
        target,
        plannedAt: Date.now(),
    };
    setAgvLabel(target.label);
}

/**
 * Compute the meeting point in front of the worker (2.5m ahead of its facing)
 */
function agvMeetingPoint() {
    const dist = 4;
    return new THREE.Vector3(
        workerMarker.position.x + Math.sin(workerYaw) * dist,
        workerMarker.position.y,
        workerMarker.position.z + Math.cos(workerYaw) * dist
    );
}

/**
 * Ensure the meeting point is not inside an obstacle: nudge outward
 * along the worker's facing until free (or fallback to worker pos + offset)
 */
function agvSafeMeetingPoint() {
    for (let dist = 4; dist <= 16; dist += 1) {
        const p = new THREE.Vector3(
            workerMarker.position.x + Math.sin(workerYaw) * dist,
            0,
            workerMarker.position.z + Math.cos(workerYaw) * dist
        );
        if (!agvCheckCollision(p.x, p.z, true)) return p;
    }
    // Fall back to just behind the worker
    return new THREE.Vector3(workerMarker.position.x, 0, workerMarker.position.z - 4);
}

/**
 * Update the AGV every frame: drive along plan, lift load, deliver to worker.
 */
function updateAGV(delta) {
    if (!agv || !agvJob) {
        // Idle bob for the beacon
        if (agv) {
            const beacon = agv.getObjectByName('agv-beacon');
            if (beacon) beacon.material.emissiveIntensity = 0.35 + Math.sin(Date.now() * 0.006) * 0.3;
        }
        return;
    }

    const beacon = agv.getObjectByName('agv-beacon');
    if (beacon) beacon.material.emissiveIntensity = 0.9 + Math.sin(Date.now() * 0.01) * 0.5;

    // Re-plan path when start/goal change significantly or an obstacle moved
    const now = Date.now();
    if (!agvPath || agvPath.length === 0 || now - lastAgvObstacleCheck > 400) {
        lastAgvObstacleCheck = now;
        planAgvStage();
    }

    if (!agvPath || agvPath.length === 0) {
        // Arrived at the current stage target
        handleAgvArrival();
    } else {
        stepAgvAlongPath(delta);
    }
}

/**
 * (Re)plan the current stage of the AGV mission
 */
function planAgvStage() {
    if (!agv || !agvJob) return;
    if (checkpoint.cancelled) return;

    const stage = agvJob.stage;
    let goal = null;

    if (stage === 'toCargo') {
        goal = agvCargoApproachPos(agvJob.target);
    } else if (stage === 'toWorker') {
        // Only re-pick the meeting point while still far away so it doesn't jitter
        if (!checkpoint.meeting || agv.position.distanceTo(workerMarker.position) > 10) {
            checkpoint.meeting = agvSafeMeetingPoint();
        }
        goal = { x: checkpoint.meeting.x, z: checkpoint.meeting.z };
    }

    if (!goal) return;

    const startX = agv.position.x;
    const startZ = agv.position.z;

    // If already at goal within a small tolerance, skip pathing
    if (Math.hypot(startX - goal.x, startZ - goal.z) < 0.7) {
        agvPath = [];
        return;
    }

    agvPath = agvPlanPath(startX, startZ, goal.x, goal.z, true);
    if (agvPath.length === 0 && Math.hypot(startX - goal.x, startZ - goal.z) > 0.7) {
        agvPath = [{ x: goal.x, z: goal.z }];   // Fallback direct
    }
}

/**
 * Where the AGV should park to pick up the cargo
 */
function agvCargoApproachPos(target) {
    if (target.kind === 'pallet') {
        const p = target.pallet.group.position;
        // Park to the west of the pallet, just clear of its obstacle AABB
        const standoff = CONFIG.collision.palletHalfWidth + CONFIG.agv.bodyLength / 2 + 0.5;
        return { x: p.x - standoff, z: p.z };
    }
    // Slot cargo: approach the shelf aisle in front of its side
    const slot = target.box.userData;
    const halfDepth = (CONFIG.rack.rackDepth - CONFIG.rack.centerGap) / 2;
    const rowZ = getRackWorldZ(slot.row);
    const aisleZ = slot.side === 0
        ? rowZ - halfDepth - 3.2
        : rowZ + halfDepth + 3.2;
    // AGV sits at the slot X, in the aisle in front of the shelf
    const x = (slot.position - (CONFIG.rack.boxesPerSide - 1) / 2) * CONFIG.rack.slotWidth;
    return { x, z: aisleZ };
}

/**
 * Move AGV toward the next waypoint
 */
function stepAgvAlongPath(delta) {
    if (!agvPath || agvPath.length === 0) return;
    const next = agvPath[0];
    const dx = next.x - agv.position.x;
    const dz = next.z - agv.position.z;
    const dist = Math.hypot(dx, dz);

    if (dist < 0.35) {
        agvPath.shift();
        return;
    }

    const dirX = dx / dist;
    const dirZ = dz / dist;

    // Face the movement direction (0 rotation = -Z facing front)
    const targetYaw = Math.atan2(dirX, dirZ);
    let deltaYaw = angleDelta(agv.rotation.y, targetYaw);
    agv.rotation.y += THREE.MathUtils.clamp(deltaYaw, -CONFIG.agv.turnSpeed * delta, CONFIG.agv.turnSpeed * delta);

    // Don't move forward until mostly facing the right way
    if (Math.abs(deltaYaw) > 0.15) return;

    const speed = CONFIG.agv.speed * (0.6 + 0.4 * Math.cos(deltaYaw));
    const step = Math.min(dist, speed * delta);
    // Collision check right before applying the step
    const nx = agv.position.x + dirX * step;
    const nz = agv.position.z + dirZ * step;
    if (!agvCheckCollision(nx, nz, true)) {
        agv.position.x = nx;
        agv.position.z = nz;
        agvLiftPulse(delta);
    } else {
        // Blocked: force a re-plan shortly
        lastAgvObstacleCheck = 0;
    }
}

/**
 * Fork lift animation: beam (and tines, which are parented to the mast) rises
 * while carrying, settles empty. The carried clone is positioned in updateCarriedCargo.
 */
function agvLiftPulse(delta) {
    const fork = agv.getObjectByName('agv-fork');
    if (!fork || !agvJob) return;
    const targetY = agvCarried ? CONFIG.agv.liftHeight : 0.35;
    fork.position.y += (targetY - fork.position.y) * Math.min(1, 4 * delta);
    // Tines share the fork beam's height (they are siblings in the mast group)
    const mast = agv.getObjectByName('agv-mast');
    if (mast) {
        mast.children.forEach((child) => {
            if (child !== fork && child.geometry && child.geometry.parameters &&
                child.geometry.parameters.height !== undefined && child.geometry.parameters.height < 0.3) {
                child.position.y = fork.position.y - 0.1;
            }
        });
    }
}

/**
 * First time a stage completes: lift cargo / start the next stage
 */
function handleAgvArrival() {
    if (!agvJob) return;

    if (agvJob.stage === 'toCargo') {
        const target = agvJob.target;
        if (target.kind === 'pallet') {
            // Palette: lift the stack mesh onto the AGV
            const stack = target.pallet.stack;
            stack.visible = false;
            agvCarried = {
                kind: 'pallet',
                pallet: target.pallet,
                mesh: stack,
                originalParent: null,
                originalPos: stack.position.clone(),
                originalY: target.pallet.group.position.y,
            };
            checkpoint.cargoDescription = `${target.pallet.id} · ${target.pallet.items || ''}`;
        } else {
            // Slot box: hide the box mesh and hold it on the AGV
            const boxMesh = target.box;
            boxMesh.visible = false;
            agvCarried = {
                kind: 'slot',
                box: boxMesh,
                mesh: boxMesh,
                originalPos: boxMesh.position.clone(),
            };
            const data = boxMesh.userData;
            checkpoint.cargoDescription = `${data.boxId}${data.item ? ' · ' + data.item : ''}`;
        }
        setAgvLabel(`🤖 載送中 ${checkpoint.cargoDescription.split(' ')[0]}`);
        agvJob.stage = 'toWorker';
        agvPath = [];
        // Move the carried load onto the fork
        placeCarriedOnFork();
    } else if (agvJob.stage === 'toWorker') {
        setAgvLabel('🤖 已送達請查收');
        agvJob.stage = 'idle';
        agvJob.doneAt = Date.now();
        // Keep the cargo displayed on the AGV fork until the next search
        agvJob.holdCargo = true;
    }
}

/**
 * Show the carried mesh on the AGV fork
 */
function placeCarriedOnFork() {
    if (!agvCarried) return;

    if (agvCarried.kind === 'slot') {
        // The box is a scene child; reparent to the AGV and pin it above the fork
        const mesh = agvCarried.box;
        agv.attach(mesh);
        mesh.visible = true;
        mesh.position.set(0, CONFIG.agv.liftHeight + CONFIG.box.height / 2, CONFIG.agv.bodyLength / 2 + CONFIG.agv.forkLength / 2 - 0.5);
        mesh.rotation.set(0, 0, 0);
        mesh.scale.set(1, 1, 1);
    } else if (agvCarried.kind === 'pallet') {
        // Keep the original stack in place but hide it, and show a clone on the fork
        const stack = agvCarried.mesh;
        stack.visible = false;
        const cloneMesh = new THREE.Mesh(stack.geometry, stack.material);
        cloneMesh.castShadow = true;
        cloneMesh.name = 'agv-cargo-clone';
        agv.add(cloneMesh);
        agvCarried.cloneMesh = cloneMesh;
        updateCarriedCargo();
    }
}

/**
 * Every frame: keep the carried load visually glued to the AGV fork
 */
function updateCarriedCargo() {
    if (!agvCarried || !agvCarried.cloneMesh) return;
    agvCarried.cloneMesh.position.set(
        0,
        CONFIG.agv.liftHeight,
        CONFIG.agv.bodyLength / 2 + CONFIG.agv.forkLength / 2 - 0.5
    );
}

/**
 * Wipe job state and return the cargo to the shelf
 */
function agvReturnCargo() {
    if (agvCarried) {
        if (agvCarried.kind === 'slot') {
            const mesh = agvCarried.box;
            // Detach from the AGV back to the scene, restore original position
            const world = new THREE.Vector3();
            mesh.getWorldPosition(world);
            scene.attach(mesh);
            mesh.position.copy(agvCarried.originalPos);
            mesh.visible = true;
        } else if (agvCarried.kind === 'pallet') {
            if (agvCarried.cloneMesh) {
                agv.remove(agvCarried.cloneMesh);
                // NOTE: geometry & material are shared with the original stack; don't dispose
                agvCarried.cloneMesh = null;
            }
            agvCarried.pallet.stack.visible = true;
        }
    }
    agvCarried = null;
    agvJob = null;
    agvPath = [];
    checkpoint.meeting = null;
    checkpoint.cancelled = false;
    if (agv) setAgvLabel('🤖 AGV 待命');
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
function showBoxInfo(boxOrSlot) {
    const data = (boxOrSlot && boxOrSlot.userData) ? boxOrSlot.userData : boxOrSlot;

    // Defensive: ignore clicks whose data isn't a real storage slot
    if (!data || !data.boxId) return;

    const hasItem = data.item && data.item !== '-' && data.item !== '';
    const sideLabel = data.side === 0 ? 'A側' : 'B側';

    document.getElementById('info-title').textContent = `📦 儲位 ${data.boxId}`;
    document.getElementById('info-location').textContent = `${data.boxId} (${sideLabel})`;
    document.getElementById('info-level').textContent = `第 ${(data.level || 0) + 1} 層`;
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

    // Worker marker drag functionality + keyboard control
    setupWorkerDrag();
    initKeyboardControl();
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
                // Keep its collision AABB aligned while the user drags it
                const record = floorPallets.find(p => p.group === draggingObject);
                if (record && record.obstacleRef) {
                    record.obstacleRef.minX = draggingObject.position.x - CONFIG.collision.palletHalfWidth;
                    record.obstacleRef.maxX = draggingObject.position.x + CONFIG.collision.palletHalfWidth;
                    record.obstacleRef.minZ = draggingObject.position.z - CONFIG.collision.palletHalfWidth;
                    record.obstacleRef.maxZ = draggingObject.position.z + CONFIG.collision.palletHalfWidth;
                }
            }
        }
    });

    renderer.domElement.addEventListener('mouseup', () => {
        if (isDraggingWorker && draggingObject) {
            isDraggingWorker = false;
            if (!cameraFollow) controls.enabled = true;   // Stay off during follow mode
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
            if (!cameraFollow) controls.enabled = true;   // Stay off during follow mode
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

/* ==================== Keyboard movement + follow camera ==================== */

/** Shortest signed angle from a to b, in (-PI, PI] */
function angleDelta(a, b) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d <= -Math.PI) d += Math.PI * 2;
    return d;
}

/**
 * Toggle follow camera on/off (F key or checkbox)
 */
function setCameraFollow(enabled) {
    cameraFollow = !!enabled;
    const followToggle = document.getElementById('toggle-follow');
    if (followToggle) followToggle.checked = cameraFollow;

    // Seed follow state from wherever the camera currently is (no snap on toggle)
    const offset = camera.position.clone().sub(workerMarker.position);

    if (cameraFollow) {
        controls.enabled = false;             // OrbitControls off while following
        followCamPos.copy(camera.position);   // Continue from the current view
        followCamLook.copy(controls.target);
        cameraFollowYaw = Math.atan2(-offset.x, -offset.z);
        followZoom = THREE.MathUtils.clamp(camera.position.distanceTo(workerMarker.position), 8, 40);
        if (highlightedBox) {                 // Camera will move away -> reroute arrows later
            clearNavigationArrows();
            createNavigationPath(highlightedBox);
        }
    } else {
        controls.enabled = true;
        // Hand the orbit rig over to the worker, viewed from behind
        const back = new THREE.Vector3(
            -Math.sin(cameraFollowYaw), 0.55, -Math.cos(cameraFollowYaw)
        ).multiplyScalar(followZoom);
        controls.target.copy(workerMarker.position);
        camera.position.copy(workerMarker.position).add(back);
    }
    updateFollowHint();
}

/**
 * Sync follow-camera checkbox/label with state
 */
function updateFollowHint() {
    const hint = document.getElementById('follow-hint');
    if (hint) hint.textContent = cameraFollow ? '鏡頭跟隨中：滾輪=距離 Q/E=環繞' : '按 F 或勾選跟隨鏡頭';
}

/**
 * Movement input: WASD + arrow keys; Shift = 快速移動
 */
function readMoveInput() {
    const forward = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) -
        (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    const right = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) -
        (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    return { forward, right, sprint: keys.has('ShiftLeft') || keys.has('ShiftRight') };
}

/**
 * Per-frame worker movement + follow-camera update
 * Movement is screen-relative: W = away from camera, A/D = left/right
 */
function updateWorkerMovement(delta) {
    if (!workerMarker || isDraggingWorker) return;

    const input = readMoveInput();
    const moving = input.forward !== 0 || input.right !== 0;

    if (moving) {
        // Camera forward projected onto the floor plane
        const forwardVec = camera.getWorldDirection(new THREE.Vector3());
        forwardVec.y = 0;
        if (forwardVec.lengthSq() < 1e-6) forwardVec.set(0, 0, 1);
        forwardVec.normalize();
        const rightVec = new THREE.Vector3(-forwardVec.z, 0, forwardVec.x);

        const speed = input.sprint ? 22 : 10;
        const move = new THREE.Vector3()
            .addScaledVector(forwardVec, input.forward * speed * delta)
            .addScaledVector(rightVec, input.right * speed * delta);
        move.y = 0;

        // Collision-aware: split the step so that the worker cannot walk
        // through floor pallets nor dense shelf cells (only ground obstacles)
        const oldPos = workerMarker.position.clone();
        workerMarker.position.add(move);
        if (groundBlockedAt(workerMarker.position.x, workerMarker.position.z)) {
            // try axis-separated fallback moves
            const stepX = new THREE.Vector3(move.x, 0, 0);
            const stepZ = new THREE.Vector3(0, 0, move.z);
            const tryX = new THREE.Vector3(oldPos.x + stepX.x, 0, oldPos.z);
            const tryZ = new THREE.Vector3(oldPos.x, 0, oldPos.z + stepZ.z);
            if (!groundBlockedAt(tryX.x, tryX.z)) {
                workerMarker.position.set(tryX.x, workerMarker.position.y, tryX.z);
            } else if (!groundBlockedAt(tryZ.x, tryZ.z)) {
                workerMarker.position.set(tryZ.x, workerMarker.position.y, tryZ.z);
            } else {
                workerMarker.position.copy(oldPos);
            }
        }

        // Turn toward walking direction (local +Z is the worker's front)
        const desiredYaw = Math.atan2(move.x, move.z);
        workerYaw += angleDelta(workerYaw, desiredYaw) * Math.min(1, 12 * delta);
        workerMarker.rotation.y = workerYaw;

        // Walking animation: bounce + squash-stretch
        bobPhase += delta * (6 + speed * 0.35);
        bobAmp = Math.min(1, bobAmp + delta * 5);
        const hop = Math.abs(Math.sin(bobPhase)) * bobAmp;
        workerMarker.position.y = 1.5 - hop * 0.35;
        workerMarker.scale.set(1 + bobAmp * 0.04 * Math.sin(bobPhase * 2), 1 - bobAmp * 0.06 * Math.sin(bobPhase * 2), 1 + bobAmp * 0.04 * Math.sin(bobPhase * 2));
        workerMarker.rotation.z = bobAmp * 0.04 * Math.sin(bobPhase);   // Slight sway
    } else {
        // Idle: ease back to rest
        bobAmp = Math.max(0, bobAmp - delta * 6);
        workerMarker.position.y = 1.5;
        workerMarker.scale.set(1, 1, 1);
        workerMarker.rotation.z = 0;
    }

    // Follow camera: behind the worker, wheel = distance, Q/E = orbit around
    if (cameraFollow) {
        const rotSpeed = 2.2;
        if (keys.has('KeyQ')) cameraFollowYaw += rotSpeed * delta;
        if (keys.has('KeyE')) cameraFollowYaw -= rotSpeed * delta;
        const desiredPos = new THREE.Vector3(
            workerMarker.position.x - Math.sin(cameraFollowYaw) * followZoom,
            workerMarker.position.y + followZoom * 0.55,
            workerMarker.position.z - Math.cos(cameraFollowYaw) * followZoom
        );
        const desiredLook = new THREE.Vector3(
            workerMarker.position.x,
            workerMarker.position.y + 2.2,
            workerMarker.position.z
        );
        const smooth = 1 - Math.exp(-10 * delta);       // Frame-rate-independent smoothing
        followCamPos.lerp(desiredPos, smooth);
        followCamLook.lerp(desiredLook, smooth);
        camera.position.copy(followCamPos);
        camera.lookAt(followCamLook);
    }
}

/**
 * Initialize keyboard/follow camera listeners
 */
function initKeyboardControl() {
    if (!clock) clock = new THREE.Clock();

    const onKeyDown = (e) => {
        if (isTypingTarget(e)) return;          // Don't hijack typing in the search box
        if (e.code.startsWith('Arrow')) e.preventDefault();   // Keep the page from scrolling
        if (e.code === 'KeyF' && !e.repeat) {
            setCameraFollow(!cameraFollow);
            e.preventDefault();
        } else {
            keys.add(e.code);
        }
    };
    const onKeyUp = (e) => keys.delete(e.code);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', () => keys.clear());   // Avoid stuck keys

    // Mouse wheel adjusts the follow-camera distance while following
    renderer.domElement.addEventListener('wheel', (e) => {
        if (!cameraFollow) return;    // OrbitControls handles zoom otherwise
        followZoom = THREE.MathUtils.clamp(followZoom + Math.sign(e.deltaY) * 1.5, 8, 40);
        e.preventDefault();
    }, { passive: false });

    const followToggle = document.getElementById('toggle-follow');
    if (followToggle) {
        followToggle.addEventListener('change', (e) => setCameraFollow(e.target.checked));
    }

    updateFollowHint();
}

/**
 * True when focus is in an input/textarea/contenteditable - don't intercept typing
 */
function isTypingTarget(e) {
    const el = e.target;
    if (!el || el === document.body) return false;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
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
    // Non-recursive: skip child objects (label sprites / edges) so the click
    // always resolves to the slot box mesh itself
    const intersects = raycaster.intersectObjects(boxes, false)
        .filter(hit => hit.object && hit.object.userData && hit.object.userData.boxId);

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
 * When follow mode is on, this disables follow (search/view jumps are free-camera moves)
 */
function animateCamera(targetPosition, targetLookAt) {
    if (cameraFollow) setCameraFollow(false);

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

    // Per-frame delta for smooth movement (clamped to avoid huge jumps after tab switch)
    const delta = clock ? Math.min(clock.getDelta(), 0.05) : 0.016;

    // Keyboard worker movement + follow camera
    updateWorkerMovement(delta);

    // AGV mission + carried cargo + reset idle jobs
    updateAGV(delta);
    updateCarriedCargo();

    // Animate worker marker ring
    if (workerMarker) {
        const ring = workerMarker.getObjectByName('worker-ring');
        if (ring) {
            ring.rotation.z += 0.02;
        }
    }

    // Animate highlighted box
    if (highlightedBox && highlightedBox.visible && highlightedBox.parent === scene) {
        const time = Date.now() * 0.003;
        const scale = 1.1 + Math.sin(time) * 0.05;
        highlightedBox.scale.set(scale, scale, scale);

        const glow = highlightedBox.getObjectByName('highlight-glow');
        if (glow) {
            glow.material.opacity = 0.2 + Math.sin(time * 2) * 0.1;
        }
    }

    // Animate navigation arrows pulsing + live-recompute the route as the worker moves
    navigationArrows.forEach((arrow, index) => {
        const time = Date.now() * 0.005 + index * 0.5;
        if (arrow.material) {
            arrow.material.opacity = 0.6 + Math.sin(time) * 0.3;
        }
    });
    if (highlightedBox) {
        const now = Date.now();
        if (now - lastPathRecalc > 800) {
            lastPathRecalc = now;
            clearNavigationArrows();
            createNavigationPath(highlightedBox);
        }
    }

    // OrbitControls should not fight the follow camera
    if (!cameraFollow) controls.update();
    renderer.render(scene, camera);
}

// Make search function globally accessible
window.searchBox = searchBox;
window.clearHighlight = clearHighlight;
window.clearNavigationArrows = clearNavigationArrows;
window.agvReturnCargo = agvReturnCargo;

// Initialize the scene
init();
