import React, { useEffect, useRef, useState  } from "react";
import { View, StyleSheet, Dimensions, Text, TouchableOpacity } from "react-native";
import { Canvas, Fill, Shader, Skia } from "@shopify/react-native-skia";
import { useSharedValue, withRepeat, withTiming, useDerivedValue, Easing, runOnJS } from "react-native-reanimated";
import { Buffer } from "buffer";
import { Audio } from "expo-av";
import { Pressable } from "react-native";
const { width, height } = Dimensions.get("window");
import * as FileSystem from "expo-file-system/legacy";
import { AudioContext } from "react-native-audio-api";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
// Define the type for our backend response to keep TS happy

const source = Skia.RuntimeEffect.Make(`
  uniform float time;
  uniform vec2 resolution;
  uniform float energy;
  uniform float motion;
  
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  
  float noise(vec2 p) {
      vec2 i = floor(p); vec2 f = fract(p);
      vec2 u = f*f*(3.0-2.0*f);
      return mix(mix(hash(i + vec2(0,0)), hash(i + vec2(1,0)), u.x),
                 mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
  }

  half4 main(vec2 pos) {
    vec2 uv = (pos - resolution.xy * 0.5) / min(resolution.x, resolution.y);
    float dist = length(uv);

    // 1. RADIUS & PULSE
    float bump = sin(time * (2.0 + energy * 2.0)) * (0.008 + energy * 0.02);
    float radius = 0.25 + bump;

    // 2. SUNLIGHT CAUSTICS (Background Projection)
    // Simulates light focusing through the glass onto the floor
    vec2 lightOffset = uv + vec2(0.15, 0.15); // Offset opposite to sunlight direction
    float caustics = exp(-length(lightOffset) * 5.0) * 1.2;
    // Add thin light "ribbons" to the caustic glow
    caustics += max(0.0, sin(length(lightOffset) * 40.0 - time) * 0.1) * exp(-length(lightOffset) * 3.0);
    
    vec3 sunColor = vec3(0.0, 0.6, 1.0); // Cyan refracted light
    vec3 shadowColor = vec3(0.05, 0.02, 0.15); // Deep purple/blue shadow base
    vec3 background = mix(shadowColor, sunColor, caustics);
    background *= exp(-dist * 2.0); // Vignette falloff

    // 3. SPHERE MASK
    float mask = smoothstep(radius, radius - 0.005, dist);
    if (mask <= 0.0) return half4(background, 1.0);

    // 4. INTERNAL SILK FLOW
    float z = sqrt(max(0.0, radius * radius - dist * dist));
    vec3 normal = normalize(vec3(uv, z));
    vec2 dir = normalize(vec2(1.0, 1.0));
    float swirl = sin(dist * (10.0 + energy * 10.0) - time * (0.5 + energy)) * (0.2 + energy * 0.3);
    float flow = dot(uv, dir) * 12.0 + swirl;
    float move = time * motion;
    
    float pattern1 = sin(flow - move + noise(uv * 3.0) * 2.0) * 0.5 + 0.5;
    float pattern2 = cos(flow * 0.5 + move * 0.5 + noise(uv * 5.0)) * 0.5 + 0.5;
    
    vec3 cyan = vec3(0.0, 0.9, 1.0);
    vec3 deepPurple = vec3(0.15, 0.0, 0.4); 
    
    vec3 liquid = mix(vec3(0.01, 0.02, 0.1), cyan, pattern1 * 0.6);
    liquid = mix(liquid, deepPurple, pattern2 * 0.5);
    liquid *= (1.4 - dist/radius); 

    // 5. SUNLIGHT OPTICS
    float fresnel = pow(1.0 - normal.z, 4.0);
    // Light hitting from top-left (opposite to caustic offset)
    vec3 lightDir = normalize(vec3(-0.8, -0.8, 1.0)); 
    float spec = pow(max(0.0, dot(normal, lightDir)), 45.0);
    
    vec3 finalSphere = liquid + (fresnel * vec3(0.4, 0.7, 1.0)) + (spec * 2.0);

    return half4(mix(background, finalSphere, mask), 1.0);
  }
`)!;

export default function SunlitGlassOrb() {
  const [isRecording, setIsRecording] = useState(false);
  const currentSourceRef = useRef<{
  stop: () => void;
} | null>(null);
  const isRecordingRef = useRef(false);
  const [isThinking, setIsThinking] = useState(false);
  // Replace your old useState with this to fix the 'never[]' error
const [history, setHistory] = useState<string[]>([]);
const lastUserTextRef = useRef<string>(""); // To fix 'lastUserText' error
const MIN_BUFFER_CHUNKS = 3;
const BUFFER_TIME_SEC = 0.25; // 250ms pre-buffer
const bufferedDurationRef = useRef(0);
const SCHEDULE_AHEAD_SEC = 0.35;
  const wsConnected = useRef(false);
  const isProcessingRef = useRef(false);
const reconnectAttempt = useRef(0);
const manualClose = useRef(false);
  const audioEngineRef = useRef({
  ctx: new AudioContext({ sampleRate: 24000 }),
  queue: [] as Float32Array[],
  playing: false,
});
const audioBufferRef = useRef<Float32Array[]>([]);
const playbackTimeRef = useRef(0); // 🔥 ADD THIS
const engine = audioEngineRef.current;
  const wsRef = useRef<WebSocket | null>(null);
const isPlayingRef = useRef(false);
  const [transcript, setTranscript] = useState<string>("");
  
  const getUserId = async () => {
  let id = await AsyncStorage.getItem("alan_user_id");

  if (!id) {
    id = Math.random().toString(36).substring(2) + Date.now().toString(36);
    await AsyncStorage.setItem("alan_user_id", id);
  }

  return id;
};

const STATE = {
  IDLE: 0,
  LISTENING: 1,
  THINKING: 2,
  SEARCHING: 3,
  SPEAKING: 4,
};
const state = useSharedValue(STATE.IDLE);
const motion = useDerivedValue(() => {
  const s = state.value;

  switch (s) {
    case STATE.LISTENING:
      return 0.6;
    case STATE.SEARCHING:
      return 0.9;
    case STATE.SPEAKING:
      return 1.2;
    default:
      return 0.4;
  }
});

const thinkingPhrases = [
  "Thinking...",
  "Processing...",
  "Analyzing...",
  "Let me think...",
  "Working on it...",
];
const [currentThinkingPhrase, setCurrentThinkingPhrase] = useState(
  thinkingPhrases[0]
);
const [uiState, setUiState] = useState(STATE.IDLE);

useDerivedValue(() => {
  runOnJS(setUiState)(state.value);
});
const getStateLabel = () => {
   switch (uiState) {
    case STATE.LISTENING:
      return "Listening...";
    case STATE.SPEAKING:
      return "Speaking...";
    case STATE.SEARCHING:
      return currentThinkingPhrase;
   
  }
};

useEffect(() => {
  if (state.value !== STATE.SEARCHING) return;

  const interval = setInterval(() => {
    setCurrentThinkingPhrase(
      thinkingPhrases[Math.floor(Math.random() * thinkingPhrases.length)]
    );
  }, 1200);

  return () => clearInterval(interval);
}, [state.value]);


const playFullAudio = async () => {
  const ctx = engine.ctx;
  if (!ctx) return;

  const chunks = audioBufferRef.current;
  audioBufferRef.current = [];

  if (chunks.length === 0) return;

  // merge all audio
  let totalLength = 0;
  for (const c of chunks) totalLength += c.length;

  const merged = new Float32Array(totalLength);

  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }

  const buffer = ctx.createBuffer(1, merged.length, 24000);
  buffer.copyToChannel(merged, 0);
  
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  
  currentSourceRef.current = source;
  await ctx.resume();
  source.start(0);
};

  // --- NEW ---
  const connectWS = React.useCallback(() => {
  if (wsConnected.current || manualClose.current) return;

  const ws = new WebSocket("wss://alan-backend-production.up.railway.app/ws");

  ws.binaryType = "arraybuffer";

  wsRef.current = ws;
  wsConnected.current = true;

  ws.onopen = () => {
    console.log("🟢 WS Connected");
    reconnectAttempt.current = 0;
   
  };

  // ALL MESSAGE LOGIC MUST LIVE INSIDE THE CALLBACK WHERE 'ws' IS DEFINED
  ws.onmessage = async (event: WebSocketMessageEvent) => {
    if (typeof event.data === "string") {
      const json = JSON.parse(event.data);
      if (json.event === "searching") {
  state.value = STATE.SEARCHING;
  setIsThinking(true);
}
if (json.event === "thinking") {
  state.value = STATE.SEARCHING;
  setIsThinking(true);
}
if (json.event === "search_done") {
  setIsThinking(false);
}
      if (json.event === "done") {
        setIsThinking(false);
        setTranscript(json.text);
        state.value = STATE.IDLE;
        isPlayingRef.current = false;
    playFullAudio();
        // Functional update ensures we have the latest history state
        setHistory((prevHistory) => {
          const updated = [
            ...prevHistory,
            `User: ${lastUserTextRef.current}`,
            `Alan: ${json.text}`,
          ].slice(-10);
          
          // Save to storage inside the update to ensure sync
          AsyncStorage.setItem("alan_conversation_history", JSON.stringify(updated));
          return updated;
        });
      }
    } else {
      // Handle binary PCM data
      playPCMChunk(event.data);
    }
  };

  ws.onerror = () => {
    ws.close();
  };

  ws.onclose = () => {
    wsConnected.current = false;

    if (manualClose.current) return;

    const timeout = Math.min(1000 * 2 ** reconnectAttempt.current, 15000);
    reconnectAttempt.current++;

    setTimeout(() => {
      connectWS();
    }, timeout);
  };
}, []);
 
const recordingRef = useRef<Audio.Recording | null>(null);
const audioContextRef = useRef<AudioContext | null>(
  new AudioContext({ sampleRate: 24000 })
);


const ctx = audioContextRef.current;


 const energy = useDerivedValue(() => {
  const s = state.value;

  switch (s) {
    case STATE.LISTENING:
      return 0.25;
    case STATE.SEARCHING:
      return 0.6;
    case STATE.SPEAKING:
      return 0.9;
    default:
      return 0.1;
  }
});



  const sendToBackend = async (uri: string) => {
  const formData = new FormData();
 
  
  formData.append("file", {
    uri,
    name: "voice.m4a",
    type: "audio/m4a",
  } as any);

  const res = await fetch("https://alan-backend-production.up.railway.app/upload-voice", {
    method: "POST",
    body: formData,
  });

  return await res.json();
};



const playBootMessage = async () => {
  const userId = await getUserId();

  wsRef.current?.send(
    JSON.stringify({
      event: "boot",
      text: "Welcome back. I'm ready when you are. How can I assist you today?",
      user_id: userId,
    })
  );

  state.value = STATE.SPEAKING;
};
  const time = useSharedValue(0);

 const interruptAudio = () => {
  if (currentSourceRef.current) {
    try {
      currentSourceRef.current.stop();
    } catch {}
    currentSourceRef.current = null;
  }

   audioBufferRef.current = []; 
  engine.queue.length = 0;
  engine.playing = false;

  playbackTimeRef.current = engine.ctx.currentTime;
  bufferedDurationRef.current = 0;
};
const rec = new Audio.Recording();
  const startRecording = async () => {
  // 1. Synchronous Guard: Block immediate double-triggers
  if (isRecordingRef.current || recordingRef.current) return;
  
 if (recordingRef.current) return; // ✅ ONLY this
  console.log("Start recording triggered");

  try {
    wsRef.current?.send(JSON.stringify({ event: "interrupt" }));
    interruptAudio();
    state.value = STATE.LISTENING;

    const permission = await Audio.requestPermissionsAsync();
    if (!permission.granted) {
      isRecordingRef.current = false;
      return;
    }

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });

    const rec = new Audio.Recording();
    await rec.prepareToRecordAsync({
  isMeteringEnabled: true,

  android: {
    extension: ".wav",
    outputFormat: Audio.AndroidOutputFormat.DEFAULT,
    audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 128000,
  },

  ios: {
    extension: ".wav",
    audioQuality: Audio.IOSAudioQuality.HIGH,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 128000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },

  // 🔥 ADD THIS
  web: {
    mimeType: "audio/webm",
    bitsPerSecond: 128000,
  },
});
    
    // Start the recording
    await rec.startAsync();
    isRecordingRef.current = true;
    console.log("Recording STARTED ✅");
    
    recordingRef.current = rec;
  } catch (e) {
    console.log("Recording FAILED ❌", e);
    isRecordingRef.current = false;
  }
};
const stopRecording = async () => {
  // 1. Immediately flag as not recording to prevent loop
  if (!isRecordingRef.current) return;
  isRecordingRef.current = false;

  const rec = recordingRef.current;
  if (!rec) return;

  try {
    // 2. Safety Buffer: If user releases too fast, wait a bit
    // This prevents the "no valid audio data" error
    const status = await rec.getStatusAsync();
    if (status.durationMillis < 500) {
       await new Promise(resolve => setTimeout(resolve, 500 - status.durationMillis));
    }

    await rec.stopAndUnloadAsync();
    console.log("Recording STOPPED 🛑");
  } catch (e) {
    console.log("Stop failed", e);
    return;
  }
   // 🔥 ALWAYS reset both
  recordingRef.current = null;
  isRecordingRef.current = false;
  setIsRecording(false);
  await new Promise(resolve => setTimeout(resolve, 150));
  const uri = rec.getURI();
  recordingRef.current = null;

  // Reset audio mode so we can hear the response
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: false,
    playsInSilentModeIOS: true,
  });

  if (uri) {
    processRecording(uri); // Separate logic for clarity
  }
};

const processRecording = async (uri: string) => {
  try {
    setIsThinking(true); 
    state.value = STATE.SEARCHING;
    console.log("📤 Uploading to backend...");
    const upload = await sendToBackend(uri);
    console.log("✅ Backend Response:", upload);
    if (upload?.text) {
      lastUserTextRef.current = upload.text;
      const userId = await getUserId();
      wsRef.current?.send(JSON.stringify({
        event: "user_message",
        text: upload.text,
        user_id: userId,
        history: history,
      }));
    }
   else {
      // If upload fails or text is empty, stop thinking
      setIsThinking(false);
      state.value = STATE.IDLE;
    }}
    catch (e) {
    console.log("Upload/WS error", e);
    state.value = STATE.IDLE;
    setIsThinking(false); 
  }
};
const animatedEnergy = useSharedValue(0.1);
const animatedMotion = useSharedValue(0.4);

useDerivedValue(() => {
  animatedEnergy.value = withTiming(energy.value, { duration: 400 });
  animatedMotion.value = withTiming(motion.value, { duration: 400 });
});
const uniforms = useDerivedValue(() => ({
  time: time.value,
  resolution: [width, height],
 motion: animatedMotion.value,
  energy: animatedEnergy.value,
}));





const convertPCM16ToFloat32 = (pcm16: Uint8Array) => {
  const len = pcm16.length / 2;
  const float32 = new Float32Array(len);

  for (let i = 0; i < len; i++) {
    const sample = (pcm16[i * 2] | (pcm16[i * 2 + 1] << 8));
    float32[i] = sample > 0x7fff ? sample - 0x10000 : sample;
    float32[i] /= 32768;
  }

  return float32;
};

const playPCMChunk = (chunk: ArrayBuffer) => {
  const pcm = new Uint8Array(chunk);
  const floatData = convertPCM16ToFloat32(pcm);

  audioBufferRef.current.push(floatData);
};

const processQueue = async () => {
  if (isProcessingRef.current) return;
  isProcessingRef.current = true;

  if (!engine.ctx) {
    isProcessingRef.current = false;
    return;
  }

  // Ensure audio context is running
  if (engine.ctx.state !== "running") {
    try {
      await engine.ctx.resume();
    } catch {
      isProcessingRef.current = false;
      return;
    }
  }

  engine.playing = true;

  while (engine.queue.length > 0) {
    const data = engine.queue.shift();
    if (!data || data.length === 0) continue;

    const buffer = engine.ctx.createBuffer(1, data.length, 24000);
    buffer.copyToChannel(data, 0);

    const source = engine.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(engine.ctx.destination);

    // 🔥 PURE SEQUENTIAL TIMELINE (NO DRIFT, NO CURRENTTIME)
    const startTime = playbackTimeRef.current;

    source.start(startTime);

    playbackTimeRef.current = startTime + buffer.duration;
  }

  engine.playing = false;
  isProcessingRef.current = false;

  // 🔁 if more data arrived mid-processing, continue
  if (engine.queue.length >= MIN_BUFFER_CHUNKS) {
    processQueue();
  }
};
  React.useEffect(() => {
  // 🌊 Orb animation loop
  time.value = withRepeat(
    withTiming(120, { duration: 120000, easing: Easing.linear }),
    -1,
    false
  );

  // 🔊 Load UI sounds
const loadSavedHistory = async () => {
    const saved = await AsyncStorage.getItem("alan_conversation_history");
    if (saved) setHistory(JSON.parse(saved));
  };
  loadSavedHistory();
  connectWS();
}, [connectWS,]);



  return (
  <Pressable
  style={{ flex: 1 }}
  onPress={async () => {
    if (!isRecording) {
      setIsRecording(true);
      await startRecording();
    } else {
      setIsRecording(false);
      state.value = STATE.THINKING;
      await stopRecording();
    }
  }}
>
    <View style={styles.container}>
      <Canvas style={styles.canvas}>
        <Fill>
          <Shader source={source} uniforms={uniforms} />
        </Fill>
        
      </Canvas>
      <View style={styles.overlay}>
     {isThinking && (
    <Text style={styles.thinkingText}></Text>
  )}
  <Text style={styles.statusText}>{getStateLabel()}</Text>
  {isRecording && (
  <View
    style={{
      width: 12,
      height: 12,
      borderRadius: 6,
      backgroundColor: "#ff3b3b",
      marginTop: 10,
    }}
  />
)}
     </View>
    </View>
    
  </Pressable>
);
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000103" },
  canvas: { flex: 1 },
  overlay: {
  position: "absolute",
  width: "100%",
  bottom: 120,
  top: 80,
  alignItems: "center",
  zIndex: 10,
},

thinkingText: {
    color: "#00fbff", // Cyan to match your orb
    fontSize: 18,
    fontWeight: "600",
    marginTop: 10,
    textShadowColor: 'rgba(0, 251, 255, 0.5)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10,
  },

text: {
  color: "white",
  fontSize: 16,
  opacity: 0.8,
  letterSpacing: 1,
},
statusText: {
  color: "#00fbff",
  fontSize: 16,
  opacity: 0.9,
  marginTop: 12,
  textShadowColor: "rgba(0, 251, 255, 0.6)",
  textShadowRadius: 8,
},
});
