export type Topic = "ურთიერთობები" | "სამსახური" | "სწავლა" | "ცხოვრება" | "სხვა";

export type Comment = {
  id: string;
  post_id: string;
  parent_id: string | null;
  body: string;
  created_at: string;
  is_mine: boolean;
};

export type Post = {
  id: string;
  body: string;
  topic: Topic;
  image_url: string | null;
  created_at: string;
  is_mine: boolean;
  comments: Comment[];
};

export type Report = {
  id: string;
  reporter_id: string;
  target_type: "post" | "comment";
  post_id: string | null;
  comment_id: string | null;
  reason: string;
  status: "open" | "resolved" | "dismissed";
  created_at: string;
  target_body?: string;
  image_url?: string | null;
  author_id?: string;
};