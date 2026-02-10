"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { getUserSession } from "@/lib/userSession";

export default function Home() {
  const [profileHref, setProfileHref] = useState("/verify");

  useEffect(() => {
    const user = getUserSession();
    if (user && user.robloxUserId) {
      setProfileHref(`/player/${user.robloxUserId}`);
    }
  }, []);

  return (
    <div className="container mx-auto px-4 py-16 space-y-12">
      <section className="text-center space-y-4">
        <h1 className="text-6xl font-bold glow-purple">
          Welcome to Azurewrath
        </h1>
        <p className="text-2xl text-slate-400 max-w-2xl mx-auto">
          Your ultimate destination for Roblox Limited trading.
        </p>
      </section>

      <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
        <div className="bg-gradient-to-br from-neon-blue/10 to-transparent border border-neon-blue/20 rounded-lg p-6">
          <div className="text-3xl mb-3">📊</div>
          <h3 className="text-xl font-semibold mb-2">Live Dashboard</h3>
          <p className="text-slate-400">
            Track prices and trends for all your favorite Limited items.
          </p>
        </div>

        <div className="bg-gradient-to-br from-neon-purple/10 to-transparent border border-neon-purple/20 rounded-lg p-6">
          <div className="text-3xl mb-3">🔍</div>
          <h3 className="text-xl font-semibold mb-2">Smart Search</h3>
          <p className="text-slate-400">
            Find the best deals and investment opportunities instantly.
          </p>
        </div>

        <div className="bg-gradient-to-br from-neon-magenta/10 to-transparent border border-neon-magenta/20 rounded-lg p-6">
          <div className="text-3xl mb-3">⚡</div>
          <h3 className="text-xl font-semibold mb-2">Real-Time Updates</h3>
          <p className="text-slate-400">
            Get instant notifications when prices change on your watchlist.
          </p>
        </div>
      </div>

      <section className="text-center mt-16">
        <Link
          href={profileHref}
          className="inline-block bg-gradient-to-r from-neon-blue to-neon-purple px-8 py-3 rounded-lg font-semibold hover:opacity-90 transition"
        >
          Get Started →
        </Link>
      </section>
    </div>
  );
}
