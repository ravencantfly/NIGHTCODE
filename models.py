from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(40), unique=True, nullable=False, index=True)
    email = db.Column(db.String(120), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime)

    def to_dict(self):
        return {"id": self.id, "username": self.username, "email": self.email}


class Room(db.Model):
    __tablename__ = "rooms"

    id = db.Column(db.String(16), primary_key=True)
    code = db.Column(db.Text, default="")
    language = db.Column(db.String(32), default="python")
    updated_at = db.Column(db.DateTime)

    def to_dict(self):
        return {
            "id": self.id,
            "code": self.code,
            "language": self.language,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class ChatMessage(db.Model):
    """Room-level text chat sidebar."""
    __tablename__ = "chat_messages"

    id = db.Column(db.Integer, primary_key=True)
    room_id = db.Column(db.String(16), index=True)
    username = db.Column(db.String(40))
    text = db.Column(db.Text)
    created_at = db.Column(db.DateTime)

    def to_dict(self):
        return {
            "username": self.username,
            "text": self.text,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class CodeSnapshot(db.Model):
    """A timestamped log of code_change events per room, used for session replay."""
    __tablename__ = "code_snapshots"

    id = db.Column(db.Integer, primary_key=True)
    room_id = db.Column(db.String(16), index=True)
    code = db.Column(db.Text)
    created_at = db.Column(db.DateTime)

    def to_dict(self):
        return {
            "code": self.code,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
