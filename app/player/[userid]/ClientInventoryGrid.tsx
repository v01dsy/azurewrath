'use client';

import { useState } from 'react';

export default function ClientInventoryGrid({ items, scannedTime }: { items: any[], scannedTime: string | null }) {
  const [sortBy, setSortBy] = useState('rap-high');
  
  // Sort items
  const sortedItems = [...items].sort((a: any, b: any) => {
    switch (sortBy) {
      case 'rap-high':
        return b.rap - a.rap;
      case 'rap-low':
        return a.rap - b.rap;
      case 'total-high':
        return (b.rap * b.count) - (a.rap * a.count);
      case 'total-low':
        return (a.rap * a.count) - (b.rap * b.count);
      case 'name':
        return a.name.localeCompare(b.name);
      default:
        return 0;
    }
  });

  return (
    <div className="bg-slate-800 rounded-2xl border border-purple-500/20 p-8 shadow-lg min-h-[400px] flex flex-col justify-center">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-white">Inventory</h2>
        <select 
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          className="bg-slate-700 text-white px-4 py-2 rounded-lg border border-purple-500/20 focus:border-purple-500/50 outline-none"
        >
          <option value="rap-high">RAP: High to Low</option>
          <option value="rap-low">RAP: Low to High</option>
          <option value="total-high">Total Value: High to Low</option>
          <option value="total-low">Total Value: Low to High</option>
          <option value="name">Name (A-Z)</option>
        </select>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-7 gap-4">
        {sortedItems.map((item: any) => (
          <div key={item.assetId} className="bg-slate-700 rounded-lg p-4 border border-purple-500/10 hover:border-purple-500/30 transition-all">
            <div className="aspect-square bg-slate-600 rounded mb-2 overflow-hidden relative flex items-center justify-center">
              <img
                src={item.imageUrl}
                alt={item.name}
                className="w-full h-full object-cover"
              />
            </div>
            <p className="text-white text-sm font-semibold truncate" title={item.name}>
              {item.name}
            </p>
            <div className="flex justify-between items-center mt-1">
              {item.count > 1 && (
                <p className="text-purple-400 text-xs font-bold">x{item.count}</p>
              )}
              <p className="text-green-400 text-xs font-semibold ml-auto">
                {item.rap.toLocaleString()} R$
              </p>
            </div>
            {item.count > 1 && (
              <p className="text-slate-400 text-xs mt-1">
                Total: {(item.rap * item.count).toLocaleString()} R$
              </p>
            )}
            {scannedTime && (
              <p className="text-slate-500 text-xs mt-2">
                Scanned {scannedTime}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}