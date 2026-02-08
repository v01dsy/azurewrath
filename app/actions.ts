// app/actions.ts
"use server";
import { neon } from "@neondatabase/serverless";

export async function getData() {
  const sql = neon(process.env.DATABASE_URL!);
  
  // Example query - replace with your actual query
  const data = await sql`SELECT * FROM "Item" LIMIT 10`;
  
  return data;
}

export async function testConnection() {
  try {
    const sql = neon(process.env.DATABASE_URL!);
    const result = await sql`SELECT NOW()`;
    return { success: true, time: result[0].now };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
