"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ShieldAlert, Users, List, Workflow, FlaskConical } from "lucide-react";

import { HomePanel } from "@/components/panels/home";
import { BatchPanel } from "@/components/panels/batch";
import { SanctionsPanel } from "@/components/panels/sanctions";
import { ExplainerPanel } from "@/components/panels/explainer";
import { EvaluatePanel } from "@/components/panels/evaluate";
import { LoginGate } from "@/components/login-gate";

gsap.registerPlugin(useGSAP);

const tabs = [
  { id: "home", label: "Screening", icon: ShieldAlert },
  { id: "batch", label: "Batch", icon: Users },
  { id: "sanctions", label: "Sanctions", icon: List },
  { id: "evaluate", label: "Evaluate", icon: FlaskConical },
  { id: "explainer", label: "Pipeline", icon: Workflow },
] as const;

type TabId = (typeof tabs)[number]["id"];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("home");
  const [guestMode, setGuestMode] = useState(false);
  const [authVersion, setAuthVersion] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const isAnimating = useRef(false);

  // Auth callback — LoginGate notifies us when role changes
  const handleAuthChange = useCallback((role: "user" | "guest" | null) => {
    setGuestMode(role === "guest");
    setActiveTab("home");
    setAuthVersion((v) => v + 1);
  }, []);

  // Set ref for each panel wrapper
  const setPanelRef = useCallback((id: string) => (el: HTMLDivElement | null) => {
    panelRefs.current[id] = el;
  }, []);

  // Entrance animation
  useGSAP(() => {
    gsap.from(".nav-bar", { y: -16, autoAlpha: 0, duration: 0.5, ease: "power3.out" });
    gsap.from(".content-panel", { y: 20, autoAlpha: 0, duration: 0.5, ease: "power3.out", delay: 0.1 });
  }, { scope: containerRef });

  // Initialize: show active panel, hide others — re-runs on auth change
  useEffect(() => {
    tabs.forEach((tab) => {
      const el = panelRefs.current[tab.id];
      if (!el) return;
      if (tab.id === activeTab) {
        gsap.set(el, { autoAlpha: 1, y: 0, position: "relative" });
      } else {
        gsap.set(el, { autoAlpha: 0, y: 0, position: "absolute", top: 0, left: 0, width: "100%" });
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authVersion]);

  const switchTab = useCallback(
    (tabId: TabId) => {
      if (tabId === activeTab || isAnimating.current) return;
      isAnimating.current = true;

      const oldPanel = panelRefs.current[activeTab];
      const newPanel = panelRefs.current[tabId];

      // Determine direction: right or left
      const tabIds = tabs.map((t) => t.id);
      const oldIdx = tabIds.indexOf(activeTab);
      const newIdx = tabIds.indexOf(tabId);
      const goingRight = newIdx > oldIdx;

      const tl = gsap.timeline({
        onComplete: () => { isAnimating.current = false; },
      });

      // Phase 1: fade out old panel
      if (oldPanel) {
        tl.to(oldPanel, {
          autoAlpha: 0,
          x: goingRight ? -30 : 30,
          duration: 0.2,
          ease: "power2.in",
          onComplete: () => {
            gsap.set(oldPanel, { position: "absolute", top: 0, left: 0, width: "100%" });
          },
        });
      }

      // Phase 2: bring in new panel
      if (newPanel) {
        tl.call(() => {
          setActiveTab(tabId);
          gsap.set(newPanel, { position: "relative", width: "auto" });
        });
        tl.fromTo(
          newPanel,
          { autoAlpha: 0, x: goingRight ? 30 : -30 },
          { autoAlpha: 1, x: 0, duration: 0.3, ease: "power2.out" },
        );
      }
    },
    [activeTab]
  );

  // Guest users can only see the Screening tab
  const visibleTabs = guestMode ? tabs.filter((t) => t.id === "home") : tabs;

  return (
    <LoginGate onAuthChange={handleAuthChange}>
    <div ref={containerRef} className="flex h-full flex-col" style={{ backgroundColor: "#f4f2f7" }}>
      {/* Navbar */}
      <header className="nav-bar shrink-0">
        <div className="flex items-center justify-center h-14 px-6">
          {/* Center: Tabs */}
          <nav className="flex items-center gap-0.5">
            {visibleTabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => switchTab(tab.id)}
                  className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all duration-200 ${
                    isActive
                      ? "bg-white text-foreground shadow-sm shadow-black/5"
                      : "text-muted-foreground hover:text-foreground hover:bg-white/50"
                  }`}
                >
                  <Icon className="w-[14px] h-[14px]" />
                  {tab.label}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      {/* Content — white panel */}
      <div className="content-panel flex-1 overflow-auto mx-4 mb-2 bg-white rounded-2xl shadow-sm shadow-black/5 ring-1 ring-black/[0.04] relative">
        <div ref={setPanelRef("home")} className="min-h-full"><HomePanel /></div>
        {!guestMode && (
          <>
            <div ref={setPanelRef("batch")} className="min-h-full"><BatchPanel /></div>
            <div ref={setPanelRef("sanctions")} className="min-h-full"><SanctionsPanel /></div>
            <div ref={setPanelRef("evaluate")} className="min-h-full"><EvaluatePanel /></div>
            <div ref={setPanelRef("explainer")} className="min-h-full"><ExplainerPanel /></div>
          </>
        )}
      </div>
    </div>
    </LoginGate>
  );
}
