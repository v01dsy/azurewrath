"use client";
import { useState, useEffect, Suspense } from "react";
import RobloxAuthSection from "../../components/RobloxAuthSection";
import { useSearchParams } from "next/navigation";

function VerifyContent() {
  const [method, setMethod] = useState<"bio" | "roblox" | null>(null);
  const searchParams = useSearchParams();
  const verified = searchParams.get("verified");
  const error = searchParams.get("error");

  useEffect(() => {
    if (verified === "true") {
      alert("Successfully verified with Roblox!");
    }
    if (error) {
      const errorMessages: Record<string, string> = {
        invalid_state: "Security verification failed. Please try again.",
        no_code: "Authorization code not received. Please try again.",
        oauth_failed: "OAuth authentication failed. Please try again.",
      };
      alert(errorMessages[error] || "An error occurred. Please try again.");
    }
  }, [verified, error]);

  return (
    <div className="bg-slate-800 rounded-2xl border border-purple-500/20 p-8 w-full max-w-md shadow-lg">
      <h1 className="text-3xl font-bold text-white mb-4 text-center">Verify Your Roblox Account</h1>
      <div className="flex flex-col gap-4 mb-6">
        <button
          className={`px-6 py-3 rounded-lg font-semibold text-white bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 transition-all duration-200 shadow-lg ${method === "bio" ? "ring-2 ring-purple-400" : ""}`}
          onClick={() => setMethod("bio")}
        >
          Verify via Roblox Bio
        </button>
        <button
          className={`px-6 py-3 rounded-lg font-semibold text-white bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 transition-all duration-200 shadow-lg ${method === "roblox" ? "ring-2 ring-blue-400" : ""}`}
          onClick={() => setMethod("roblox")}
        >
          Verify via Roblox OAuth
        </button>
      </div>
      {method === null && (
        <div className="text-purple-200 text-center">Choose a verification method above.</div>
      )}
      {method === "bio" && (
        <div className="mt-4">
          <h2 className="text-xl font-bold text-white mb-2">Bio Verification</h2>
          <p className="text-purple-200 mb-2">this kih don't trust me 😹</p>
          <RobloxAuthSection />
        </div>
      )}
      {method === "roblox" && (
        <div className="mt-4">
          <h2 className="text-xl font-bold text-white mb-2">Roblox OAuth</h2>
          <p className="text-blue-200 mb-4">
            Securely verify your account using Roblox's official login system.
          </p>
          <button
            onClick={() => window.location.href = '/api/auth/roblox'}
            className="w-full px-6 py-3 rounded-lg font-semibold text-white bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 transition-all duration-200 shadow-lg"
          >
            Login with Roblox
          </button>
        </div>
      )}
    </div>
  );
}

export default function VerifyPage() {
  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-4">
      <Suspense fallback={
        <div className="bg-slate-800 rounded-2xl border border-purple-500/20 p-8 w-full max-w-md shadow-lg">
          <div className="text-white text-center">Loading...</div>
        </div>
      }>
        <VerifyContent />
      </Suspense>
    </div>
  );
}