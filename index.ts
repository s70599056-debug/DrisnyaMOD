import "frida-il2cpp-bridge";

const WARDS_PER_ROUND = 2;
const MEDIC_REVIVES = 1;
const WARD_RADIUS = 4.5;
const VOICE_MAX_DIST = 5.5;

const RPC_WARD = 200;
const RPC_REVIVE = 201;
const RPC_ROLES = 202;
const RPC_VOICE = 203;

Il2Cpp.perform(() => {
  const A = Il2Cpp.domain.assembly("Assembly-CSharp").image;
  const U = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image;
  const UAudio = Il2Cpp.domain.assembly("UnityEngine.AudioModule").image;
  const UImage = Il2Cpp.domain.assembly("UnityEngine.ImageConversionModule").image;
  const Mscorlib = Il2Cpp.domain.assembly("mscorlib").image;

  const PlayerControl = A.class("PlayerControl");
  const AmongUsClient = A.class("AmongUsClient");
  const HudManager = A.class("HudManager");
  const ShipStatus = A.class("ShipStatus");
  const MeetingHud = A.class("MeetingHud");
  const RoleManager = A.class("RoleManager");
  const DeadBody = A.class("DeadBody");

  const UObject = U.class("UnityEngine.Object");
  const GameObject = U.class("UnityEngine.GameObject");
  const Vector2 = U.class("UnityEngine.Vector2");
  const Vector3 = U.class("UnityEngine.Vector3");
  const Color = U.class("UnityEngine.Color");
  const Texture2D = U.class("UnityEngine.Texture2D");
  const Sprite = U.class("UnityEngine.Sprite");
  const Rect = U.class("UnityEngine.Rect");
  const SpriteRenderer = U.class("UnityEngine.SpriteRenderer");

  let medicId = 255;
  let warderId = 255;
  let wardsLeft = WARDS_PER_ROUND;
  let revivesLeft = MEDIC_REVIVES;

  const noChat = new Set<number>();
  const wards: { x: number; y: number; obj: any }[] = [];
  let lastSeen = "";
  let lastTick = 0;

  let isMicMuted = false;
  let micClip: any = null;
  let localAudioSource: any = null;
  let muteButtonObj: any = null;

  const alive = (o: any) => o !== null && o !== undefined && !(o.isNull && o.isNull());
  const inst = (c: any): any => {
    try {
      const o = c.field("Instance").value as any;
      return alive(o) ? o : null;
    } catch (e) {
      return null;
    }
  };
  const me = (): any => {
    try {
      const o = PlayerControl.field("LocalPlayer").value as any;
      return alive(o) ? o : null;
    } catch (e) {
      return null;
    }
  };
  const pid = (p: any) => p.field("PlayerId").value as number;
  const data = (p: any): any => p.method("get_Data").invoke();
  const isDead = (p: any) => data(p).field("IsDead").value as boolean;
  const roleType = (p: any) => {
    const r = data(p).field("Role").value as any;
    return alive(r) ? (r.field("Role").value as number) : -1;
  };
  const isImp = (p: any) => {
    const r = data(p).field("Role").value as any;
    return alive(r) && (r.method("get_IsImpostor").invoke() as boolean);
  };
  const pname = (p: any) => {
    try {
      return (data(p).field("PlayerName").value as any).content as string;
    } catch (e) {
      return "?";
    }
  };
  const vxy = (v: any) => ({ x: v.field("x").value as number, y: v.field("y").value as number });
  const posOf = (p: any) => vxy(p.method("GetTruePosition").invoke());
  const bodyPos = (b: any) => vxy(b.method("get_transform").invoke().method("get_position").invoke());
  const dist = (a: any, b: any) => Math.hypot(a.x - b.x, a.y - b.y);
  const inGame = () => inst(ShipStatus) !== null && me() !== null;
  const canAct = () => inGame() && !isDead(me()) && inst(MeetingHud) === null;
  const amHost = () => {
    const c = inst(AmongUsClient);
    return c !== null && (c.method("get_AmHost").invoke() as boolean);
  };
  const allPlayers = (): any[] => Il2Cpp.gc.choose(PlayerControl) as any[];
  const byId = (id: number) => allPlayers().find(p => pid(p) === id) || null;

  const makeColor = (r: number, g: number, b: number, a = 1.0) => {
    const c = Color.alloc() as any;
    c.method(".ctor", 4).invoke(r, g, b, a);
    return c.unbox();
  };

  const makeVec3 = (x: number, y: number, z: number) => {
    const v = Vector3.alloc() as any;
    v.method(".ctor", 3).invoke(x, y, z);
    return v.unbox();
  };

  const makeVec2 = (x: number, y: number) => {
    const v = Vector2.alloc() as any;
    v.method(".ctor", 2).invoke(x, y);
    return v.unbox();
  };

  const say = (t: string) => {
    try {
      inst(HudManager).field("Notifier").value.method("AddDisconnectMessage").invoke(Il2Cpp.string(t));
    } catch (e) {
      console.log("[KidsMod] " + t);
    }
  };

  function sendRpc(id: number, write: (w: any) => void) {
    const c = inst(AmongUsClient), p = me();
    if (!c || !p) return;
    const w = c.method("StartRpcImmediately").invoke(p.field("NetId").value, id, 1, -1) as any;
    write(w);
    c.method("FinishRpcImmediately").invoke(w);
  }
  const wf = (w: any, x: number) => w.method("Write").overload("System.Single").invoke(x);
  const wb = (w: any, x: number) => w.method("Write").overload("System.Byte").invoke(x);

  function hook(cls: string, name: string, impl: (self: any, orig: (...a: any[]) => any, args: any[]) => any, argc?: number): boolean {
    try {
      const k = A.class(cls);
      const m = argc === undefined ? k.method(name) : k.method(name, argc);
      m.implementation = function (this: any, ...args: any[]) {
        const self = this;
        const orig = (...a: any[]) => (argc === undefined ? self.method(name) : self.method(name, argc)).invoke(...(a.length ? a : args));
        return impl(self, orig, args);
      };
      return true;
    } catch (e) {
      return false;
    }
  }

  function createWardSprite(): any {
    const size = 64;
    const tex = Texture2D.alloc() as any;
    tex.method(".ctor", 2).invoke(size, size);
    const center = size / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x - center, y - center);
        if (d > 28 && d <= 31) {
          tex.method("SetPixel", 3).invoke(x, y, makeColor(0.2, 0.9, 1.0, 0.85));
        } else if (d <= 12 && d > 5) {
          tex.method("SetPixel", 3).invoke(x, y, makeColor(1.0, 0.85, 0.1, 0.95));
        } else if (d <= 5) {
          tex.method("SetPixel", 3).invoke(x, y, makeColor(0.1, 0.6, 1.0, 1.0));
        } else {
          tex.method("SetPixel", 3).invoke(x, y, makeColor(0, 0, 0, 0));
        }
      }
    }
    tex.method("Apply", 0).invoke();
    const rect = Rect.alloc() as any;
    rect.method(".ctor", 4).invoke(0, 0, size, size);
    return Sprite.method("Create", 4).invoke(tex, rect.unbox(), makeVec2(0.5, 0.5), 32.0);
  }

  function spawnVisualWard(x: number, y: number): any {
    try {
      const p = me();
      if (!p || !isImp(p)) return null;
      const wardObj = GameObject.alloc() as any;
      wardObj.method(".ctor", 1).invoke(Il2Cpp.string("DotaObserverWard"));
      const tr = wardObj.method("get_transform").invoke();
      tr.method("set_position").invoke(makeVec3(x, y, -0.5));
      tr.method("set_localScale").invoke(makeVec3(1.4, 1.4, 1.0));
      const sr = wardObj.method("AddComponent", 1).invoke(SpriteRenderer.type.object);
      sr.method("set_sprite").invoke(createWardSprite());
      sr.method("set_sortingOrder").invoke(50);
      return wardObj;
    } catch (e) {
      return null;
    }
  }

  function clearVisualWards() {
    for (const w of wards) {
      if (alive(w.obj)) {
        try { UObject.method("Destroy", 1).invoke(w.obj); } catch (e) {}
      }
    }
    wards.length = 0;
  }

  function setRoles(m: number, w: number) {
    medicId = m;
    warderId = w;
    wardsLeft = WARDS_PER_ROUND;
    revivesLeft = MEDIC_REVIVES;
    const p = me();
    if (!p) return;
    if (pid(p) === m) say("🟢 ТЫ МЕДИК! Подойди к телу и нажми ЛЕЧИТЬ.");
    else if (pid(p) === w) say("👁 ТЫ ВАРДЕР! Ставь до 2 вардов за раунд кнопкой ВАРД.");
  }

  function resetAll() {
    medicId = 255;
    warderId = 255;
    wardsLeft = WARDS_PER_ROUND;
    revivesLeft = MEDIC_REVIVES;
    noChat.clear();
    clearVisualWards();
    lastSeen = "";
  }

  function placeWard() {
    if (wardsLeft <= 0) {
      say("Варды закончились!");
      return;
    }
    const p = posOf(me());
    wardsLeft--;
    const obj = spawnVisualWard(p.x, p.y);
    wards.push({ x: p.x, y: p.y, obj });
    sendRpc(RPC_WARD, w => {
      wf(w, p.x);
      wf(w, p.y);
    });
    say("👁 Вард установлен! Осталось: " + wardsLeft);
  }

  function doRevive(id: number, x: number, y: number) {
    for (const b of Il2Cpp.gc.choose(DeadBody) as any[]) {
      if ((b.field("ParentId").value as number) === id) {
        UObject.method("Destroy", 1).invoke(b.method("get_gameObject").invoke());
      }
    }
    const p = byId(id);
    if (!p) return;
    p.method("Revive").invoke();
    inst(RoleManager).method("SetRole").invoke(p, 0);
    p.field("NetTransform").value.method("SnapTo", 1).invoke(makeVec2(x, y));
    noChat.add(id);

    if (p.method("get_AmOwner").invoke() as boolean) {
      say("💚 Тебя спас Медик! Но писать в чат нельзя.");
    }
  }

  function tryRevive() {
    if (revivesLeft <= 0) {
      say("Аптечка пуста!");
      return;
    }
    const mine = posOf(me());
    let best: any = null;
    let bd = 2.0;
    for (const b of Il2Cpp.gc.choose(DeadBody) as any[]) {
      const d = dist(mine, bodyPos(b));
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    if (!best) {
      say("Рядом нет тела!");
      return;
    }
    revivesLeft--;
    const bp = bodyPos(best);
    const id = best.field("ParentId").value as number;
    sendRpc(RPC_REVIVE, w => {
      wb(w, id);
      wf(w, bp.x);
      wf(w, bp.y);
    });
    doRevive(id, bp.x, bp.y);
    say("💚 Космонавт вылечен!");
  }

  function useAbility() {
    if (!canAct()) return;
    const id = pid(me());
    if (id === warderId) placeWard();
    else if (id === medicId) tryRevive();
  }

  const isMyRole = () => {
    const p = me();
    return !!p && inGame() && (pid(p) === warderId || pid(p) === medicId);
  };

  hook("PlayerControl", "HandleRpc", (self, orig, args) => {
    const callId = args[0] as number;
    const reader = args[1];
    if (callId === RPC_WARD) {
      const x = reader.method("ReadSingle").invoke() as number;
      const y = reader.method("ReadSingle").invoke() as number;
      const p = me();
      if (p && inGame() && isImp(p)) {
        const obj = spawnVisualWard(x, y);
        wards.push({ x, y, obj });
      }
      return;
    }
    if (callId === RPC_REVIVE) {
      const id = reader.method("ReadByte").invoke() as number;
      const x = reader.method("ReadSingle").invoke() as number;
      const y = reader.method("ReadSingle").invoke() as number;
      doRevive(id, x, y);
      return;
    }
    if (callId === RPC_ROLES) {
      const m = reader.method("ReadByte").invoke() as number;
      const w = reader.method("ReadByte").invoke() as number;
      setRoles(m, w);
      return;
    }
    return orig();
  }, 2);

  hook("IntroCutscene", "OnDestroy", (self, orig) => {
    orig();
    try {
      if (!amHost()) return;
      const crew: number[] = [];
      const imps: number[] = [];
      for (const p of allPlayers()) {
        const d = data(p);
        if (d.field("Disconnected").value as boolean) continue;
        const r = roleType(p);
        if (r === 0) crew.push(pid(p));
        else if (r === 1) imps.push(pid(p));
      }
      const m = crew.length >= 1 ? crew[Math.floor(Math.random() * crew.length)] : 255;
      const w = imps.length > 0 ? imps[Math.floor(Math.random() * imps.length)] : 255;
      setRoles(m, w);
      sendRpc(RPC_ROLES, wr => {
        wb(wr, m);
        wb(wr, w);
      });
    } catch (e) {}
  });

  hook("PlayerControl", "RpcSendChat", (self, orig) => {
    const p = me();
    if (p && noChat.has(pid(p))) {
      say("🤐 Писать в чат нельзя!");
      return false;
    }
    return orig();
  }, 1);

  hook("MeetingHud", "Start", (self, orig) => {
    orig();
    clearVisualWards();
    wardsLeft = WARDS_PER_ROUND;
    lastSeen = "";
  });

  hook("AmongUsClient", "OnGameEnd", (self, orig) => {
    orig();
    resetAll();
  }, 1);

  hook("LobbyBehaviour", "Start", (self, orig) => {
    orig();
    resetAll();
  });

  hook("AbilityButton", "DoClick", (self, orig) => {
    if (isMyRole()) {
      useAbility();
      return;
    }
    return orig();
  });

  console.log("[KidsMod] Загружено!");
});