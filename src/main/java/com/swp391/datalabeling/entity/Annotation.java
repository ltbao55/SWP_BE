package com.swp391.datalabeling.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.LocalDateTime;

@Entity
@Table(name = "annotations")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Annotation {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "task_id", nullable = false)
    private Task task;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "label_class_id", nullable = false)
    private LabelClass labelClass;

    // JSON data: bounding box, polygon, etc. {"x":10,"y":20,"width":100,"height":50}
    @Column(name = "annotation_data", columnDefinition = "TEXT")
    private String annotationData;

    @Column(name = "annotation_type", length = 50)
    private String annotationType;

    @CreationTimestamp
    @Column(name = "created_at", updatable = false)
    private LocalDateTime createdAt;
}
